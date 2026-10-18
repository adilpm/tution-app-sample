// Dues are never stored. A student's ledger is derived from:
//   billing window (billing_start .. billing_end) x section history x fee rates
// minus the non-voided payment allocations for each month.

const { db, getSetting } = require('../db');
const { currentMonth, addMonths, monthRange } = require('./dates');

function loadContext() {
  const ratesByClass = new Map();
  for (const r of db.prepare('SELECT class_id, amount, effective_from FROM fee_rates ORDER BY effective_from').all()) {
    if (!ratesByClass.has(r.class_id)) ratesByClass.set(r.class_id, []);
    ratesByClass.get(r.class_id).push(r);
  }
  const sectionClass = new Map(db.prepare('SELECT id, class_id FROM sections').all().map((s) => [s.id, s.class_id]));
  const skip = new Set((getSetting('skip_months') || '').split(',').map((s) => s.trim()).filter(Boolean));
  return { ratesByClass, sectionClass, skip };
}

function rateFor(ctx, classId, month) {
  const rates = ctx.ratesByClass.get(classId) || [];
  let amount = rates.length ? rates[0].amount : 0;
  for (const r of rates) {
    if (r.effective_from > month) break;
    amount = r.amount;
  }
  return amount;
}

function sectionFor(enrollments, month, fallback) {
  let sectionId = enrollments.length ? enrollments[0].section_id : fallback;
  for (const e of enrollments) {
    if (e.from_month > month) break;
    sectionId = e.section_id;
  }
  return sectionId;
}

function groupBy(rows, key) {
  const map = new Map();
  for (const row of rows) {
    if (!map.has(row[key])) map.set(row[key], []);
    map.get(row[key]).push(row);
  }
  return map;
}

function inClause(ids) {
  return ids ? `WHERE student_id IN (${ids.map(() => '?').join(',')})` : '';
}

/**
 * Returns Map<studentId, ledger> where ledger = {
 *   months: [{ month, charge, paid, due, section_id }]  (billed months up to asOf),
 *   pending, unpaidMonths: [month], advance, totalPaid
 * }
 */
function buildLedgers({ studentIds = null, asOf = currentMonth() } = {}) {
  const ctx = loadContext();
  const ids = studentIds && studentIds.length ? studentIds.map(Number) : null;
  if (studentIds && !ids) return new Map();

  const students = ids
    ? db.prepare(`SELECT * FROM students WHERE id IN (${ids.map(() => '?').join(',')})`).all(...ids)
    : db.prepare('SELECT * FROM students').all();
  const enrollments = groupBy(
    db.prepare(`SELECT student_id, section_id, from_month FROM enrollments ${inClause(ids)} ORDER BY from_month`).all(...(ids || [])),
    'student_id',
  );
  const allocations = groupBy(
    db.prepare(`
      SELECT p.student_id, pm.month, SUM(pm.amount) AS amount
      FROM payment_months pm JOIN payments p ON p.id = pm.payment_id
      WHERE p.voided = 0 ${ids ? `AND p.student_id IN (${ids.map(() => '?').join(',')})` : ''}
      GROUP BY p.student_id, pm.month
    `).all(...(ids || [])),
    'student_id',
  );

  const out = new Map();
  for (const s of students) {
    const enr = enrollments.get(s.id) || [];
    const paidByMonth = new Map((allocations.get(s.id) || []).map((a) => [a.month, a.amount]));
    const end = s.billing_end && s.billing_end < asOf ? s.billing_end : asOf;

    const months = [];
    for (const month of monthRange(s.billing_start, end)) {
      if (ctx.skip.has(month.slice(5))) continue;
      const sectionId = sectionFor(enr, month, s.section_id);
      const charge = rateFor(ctx, ctx.sectionClass.get(sectionId), month);
      const paid = paidByMonth.get(month) || 0;
      months.push({ month, charge, paid, due: Math.max(0, charge - paid), section_id: sectionId });
    }

    const billed = new Set(months.map((m) => m.month));
    let advance = 0;
    let totalPaid = 0;
    for (const [month, amount] of paidByMonth) {
      totalPaid += amount;
      if (!billed.has(month)) advance += amount;
    }

    out.set(s.id, {
      months,
      pending: months.reduce((sum, m) => sum + m.due, 0),
      unpaidMonths: months.filter((m) => m.due > 0).map((m) => m.month),
      advance,
      totalPaid,
    });
  }
  return out;
}

function ledgerFor(studentId, asOf) {
  return buildLedgers({ studentIds: [studentId], asOf }).get(Number(studentId));
}

// Current monthly fee for a student, based on their section's class.
function monthlyFee(student, month = currentMonth()) {
  const ctx = loadContext();
  return rateFor(ctx, ctx.sectionClass.get(student.section_id), month);
}

/**
 * Splits `amount` across the student's months, oldest unpaid first, spilling
 * into up to 24 future months as advance. Throws if it cannot all be placed
 * (e.g. the student has left and owes less than the amount).
 */
function allocate(studentId, amount) {
  const ledger = ledgerFor(studentId, addMonths(currentMonth(), 24));
  let remaining = amount;
  const parts = [];
  for (const m of ledger.months) {
    if (remaining <= 0) break;
    if (m.due <= 0) continue;
    const take = Math.min(m.due, remaining);
    parts.push({ month: m.month, amount: take });
    remaining -= take;
  }
  if (remaining > 0) {
    const err = new Error('Amount is more than everything this student can owe. Check the amount.');
    err.userFacing = true;
    throw err;
  }
  return parts;
}

module.exports = { buildLedgers, ledgerFor, monthlyFee, allocate };

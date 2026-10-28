// Dues are never stored. A student's ledger is derived from:
//   billing window (billing_start .. billing_end) x section history x fee rates
// minus the non-voided payment allocations for each month.

const { db, getSetting } = require('../db');
const {
  currentMonth, addMonths, monthRange, monthsSummary, monthLabel,
} = require('./dates');

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
  const charges = groupBy(
    db.prepare(`
      SELECT c.id, c.student_id, c.title, c.amount, c.month,
             COALESCE((SELECT SUM(pc.amount) FROM payment_charges pc JOIN payments p ON p.id = pc.payment_id
                       WHERE pc.charge_id = c.id AND p.voided = 0), 0) AS paid
      FROM charges c
      WHERE c.voided = 0 ${ids ? `AND c.student_id IN (${ids.map(() => '?').join(',')})` : ''}
      ORDER BY c.month, c.id
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

    const extra = (charges.get(s.id) || []).map((c) => ({
      id: c.id, title: c.title, month: c.month, charge: c.amount, paid: c.paid, due: Math.max(0, c.amount - c.paid),
    }));

    out.set(s.id, {
      months,
      charges: extra,
      pending: months.reduce((sum, m) => sum + m.due, 0) + extra.reduce((sum, c) => sum + c.due, 0),
      unpaidMonths: months.filter((m) => m.due > 0).map((m) => m.month),
      unpaidCharges: extra.filter((c) => c.due > 0),
      advance,
      totalPaid: totalPaid + extra.reduce((sum, c) => sum + c.paid, 0),
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

// "Aug – Oct 2026, Exam fee" style summary of what a ledger still owes.
function duesSummary(ledger) {
  return [monthsSummary(ledger.unpaidMonths), ...ledger.unpaidCharges.map((c) => c.title)]
    .filter(Boolean).join(', ');
}

/**
 * Splits `amount` across the student's dues, oldest first (a one-time fee goes
 * before that month's monthly fee), spilling into up to 24 future months as
 * advance. Returns [{ month, amount } | { chargeId, amount }]. Throws if it
 * cannot all be placed (e.g. the student has left and owes less).
 */
function allocate(studentId, amount) {
  const ledger = ledgerFor(studentId, addMonths(currentMonth(), 24));
  const items = [
    ...ledger.charges.map((c) => ({ key: `${c.month}-0`, due: c.due, part: { chargeId: c.id } })),
    ...ledger.months.map((m) => ({ key: `${m.month}-1`, due: m.due, part: { month: m.month } })),
  ].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));

  let remaining = amount;
  const parts = [];
  for (const item of items) {
    if (remaining <= 0) break;
    if (item.due <= 0) continue;
    const take = Math.min(item.due, remaining);
    parts.push({ ...item.part, amount: take });
    remaining -= take;
  }
  if (remaining > 0) {
    const err = new Error('Amount is more than everything this student can owe. Check the amount.');
    err.userFacing = true;
    throw err;
  }
  return parts;
}

// Writes a payment's allocation rows inside the caller's transaction.
function saveAllocation(paymentId, parts) {
  const toMonth = db.prepare('INSERT INTO payment_months (payment_id, month, amount) VALUES (?, ?, ?)');
  const toCharge = db.prepare('INSERT INTO payment_charges (payment_id, charge_id, amount) VALUES (?, ?, ?)');
  for (const p of parts) {
    if (p.chargeId) toCharge.run(paymentId, p.chargeId, p.amount);
    else toMonth.run(paymentId, p.month, p.amount);
  }
}

// What a payment was for, as receipt lines: [{ label, amount }].
function paymentLines(paymentId) {
  return [
    ...db.prepare(`
      SELECT c.title AS label, pc.amount, c.month AS sort FROM payment_charges pc JOIN charges c ON c.id = pc.charge_id
      WHERE pc.payment_id = ?
    `).all(paymentId),
    ...db.prepare('SELECT month AS sort, amount FROM payment_months WHERE payment_id = ?').all(paymentId)
      .map((m) => ({ label: monthLabel(m.sort), amount: m.amount, sort: m.sort })),
  ].sort((a, b) => (a.sort < b.sort ? -1 : a.sort > b.sort ? 1 : 0))
    .map(({ label, amount }) => ({ label, amount }));
}

module.exports = {
  buildLedgers, ledgerFor, monthlyFee, allocate, saveAllocation, paymentLines, duesSummary,
};

const express = require('express');
const { db, getSections, getSettings } = require('../db');
const { requireAdmin } = require('../lib/auth');
const {
  buildLedgers, ledgerFor, monthlyFee, allocate, saveAllocation, paymentLines, duesSummary,
} = require('../lib/ledger');
const {
  RANGES, resolveRange, rangeLabel, rangeQuery,
} = require('../lib/ranges');
const { writeReceipt } = require('../lib/receipt');
const { track } = require('../lib/analytics');
const { writePaymentsPdf, writePaymentsXlsx } = require('../lib/report');
const { today, monthsSummary, isDate } = require('../lib/dates');
const { money, waLink, csvRow } = require('../lib/format');

const router = express.Router();
router.use(['/collect', '/payments', '/payments.csv', '/payments.pdf', '/payments.xlsx'], requireAdmin);

const sectionLabels = () => new Map(getSections().map((s) => [s.id, s.label]));

// ---------- Collect fee ----------

router.get('/collect', (req, res) => {
  const labels = sectionLabels();
  const students = db.prepare('SELECT id, name, parent_name, phone, section_id, status FROM students ORDER BY name').all();
  const ledgers = buildLedgers();
  const list = students
    .map((s) => ({
      id: s.id,
      name: s.name,
      parent: s.parent_name || '',
      phone: s.phone || '',
      label: labels.get(s.section_id),
      pending: ledgers.get(s.id)?.pending || 0,
      active: s.status === 'active',
    }))
    // Former students only matter here if they still owe money.
    .filter((s) => s.active || s.pending > 0);
  res.render('collect/search', { title: 'Collect fee', list });
});

function renderCollectForm(res, student, form, error, status = 200) {
  const ledger = ledgerFor(student.id);
  const fee = monthlyFee(student);
  const label = sectionLabels().get(student.section_id);
  res.status(status).render('collect/form', {
    title: 'Collect fee',
    student,
    label,
    ledger,
    dues: duesSummary(ledger),
    fee,
    form: {
      amount: ledger.pending > 0 ? ledger.pending : fee,
      method: 'Cash',
      paid_on: today(),
      note: '',
      ...form,
    },
    error,
  });
}

router.get('/collect/:id', (req, res) => {
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(Number(req.params.id));
  if (!student) return res.status(404).render('error', { title: 'Not found', message: 'Student not found.' });
  renderCollectForm(res, student, {}, null);
});

router.post('/collect/:id', (req, res) => {
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(Number(req.params.id));
  if (!student) return res.status(404).render('error', { title: 'Not found', message: 'Student not found.' });

  const form = {
    amount: String(req.body.amount || '').replace(/[,\s₹]/g, ''),
    method: req.body.method === 'UPI' ? 'UPI' : 'Cash',
    paid_on: String(req.body.paid_on || ''),
    note: String(req.body.note || '').trim().slice(0, 300),
  };
  const amount = Number(form.amount);
  if (!/^\d+$/.test(form.amount) || amount <= 0 || amount > 10000000) {
    return renderCollectForm(res, student, form, 'Enter the amount in whole rupees.', 400);
  }
  if (!isDate(form.paid_on) || form.paid_on > today()) {
    return renderCollectForm(res, student, form, 'Payment date must be today or earlier.', 400);
  }

  // A double-tap on "Save" should not create two receipts.
  const duplicate = db.prepare(`
    SELECT id FROM payments WHERE student_id = ? AND amount = ? AND voided = 0
      AND created_at >= datetime('now', '-15 seconds')
  `).get(student.id, amount);
  if (duplicate) return res.redirect(`/payments/${duplicate.id}`);

  let paymentId;
  let parts;
  try {
    paymentId = db.transaction(() => {
      parts = allocate(student.id, amount);
      const year = form.paid_on.slice(0, 4);
      const { seq } = db.prepare(`
        SELECT COALESCE(MAX(CAST(substr(receipt_no, 8) AS INTEGER)), 0) + 1 AS seq
        FROM payments WHERE receipt_no LIKE ?
      `).get(`R-${year}-%`);
      const receiptNo = `R-${year}-${String(seq).padStart(4, '0')}`;
      const id = db.prepare(`
        INSERT INTO payments (receipt_no, student_id, amount, method, paid_on, note, collected_by)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(receiptNo, student.id, amount, form.method, form.paid_on, form.note || null, req.user.id).lastInsertRowid;
      saveAllocation(id, parts);
      return id;
    })();
  } catch (err) {
    if (err.userFacing) return renderCollectForm(res, student, form, err.message, 400);
    throw err;
  }
  track(req.user, 'fee_collected', {
    amount,
    method: form.method,
    months: parts.filter((p) => p.month).length,
    one_time_fees: parts.filter((p) => p.chargeId).length,
    backdated: form.paid_on !== today(),
  });
  res.redirect(`/payments/${paymentId}?new=1`);
});

// ---------- Receipts ----------

function loadPayment(id) {
  const payment = db.prepare(`
    SELECT p.*, u.name AS collected_by_name, v.name AS voided_by_name
    FROM payments p
    LEFT JOIN users u ON u.id = p.collected_by
    LEFT JOIN users v ON v.id = p.voided_by
    WHERE p.id = ?
  `).get(Number(id));
  if (!payment) return null;
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(payment.student_id);
  return {
    payment, student, lines: paymentLines(payment.id), label: sectionLabels().get(student.section_id),
  };
}

router.get('/payments/:id(\\d+)', (req, res) => {
  const data = loadPayment(req.params.id);
  if (!data) return res.status(404).render('error', { title: 'Not found', message: 'Receipt not found.' });
  const { payment, student, lines, label } = data;
  const center = res.locals.settings.center_name;
  const shareText = `Payment received: ${money(payment.amount)} from ${student.name} (Class ${label}) `
    + `for ${lines.map((l) => l.label).join(', ')}. Receipt No: ${payment.receipt_no}, `
    + `Date: ${res.locals.dates.dateLabel(payment.paid_on)}. Thank you! - ${center}`;
  const ledger = ledgerFor(student.id);
  res.render('collect/receipt', {
    title: payment.receipt_no,
    ...data,
    ledger,
    isNew: req.query.new === '1',
    whatsapp: payment.voided ? null : waLink(student.phone, shareText),
  });
});

router.get('/payments/:id(\\d+)/pdf', (req, res) => {
  const data = loadPayment(req.params.id);
  if (!data) return res.status(404).send('Receipt not found');
  const { payment, student, lines, label } = data;
  const slug = student.name.replace(/[^a-z0-9]+/gi, '_').replace(/^_|_$/g, '');
  const filename = `${payment.receipt_no}_${slug}.pdf`;
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `${req.query.download ? 'attachment' : 'inline'}; filename="${filename}"`,
    'Cache-Control': 'private, no-store',
  });
  writeReceipt(res, {
    payment,
    student,
    sectionLabel: label,
    lines,
    settings: getSettings(),
    collectedBy: payment.collected_by_name,
  });
});

router.post('/payments/:id(\\d+)/void', (req, res) => {
  const data = loadPayment(req.params.id);
  if (!data) return res.status(404).render('error', { title: 'Not found', message: 'Receipt not found.' });
  const reason = String(req.body.reason || '').trim().slice(0, 300);
  if (!reason) {
    req.flash('error', 'Give a reason for voiding this receipt.');
    return res.redirect(`/payments/${data.payment.id}`);
  }
  db.prepare(`
    UPDATE payments SET voided = 1, void_reason = ?, voided_by = ?, voided_at = CURRENT_TIMESTAMP
    WHERE id = ? AND voided = 0
  `).run(reason, req.user.id, data.payment.id);
  track(req.user, 'receipt_voided', { amount: data.payment.amount });
  req.flash('success', `Receipt ${data.payment.receipt_no} voided. The amount is pending again.`);
  res.redirect(`/payments/${data.payment.id}`);
});

// ---------- Payments report ----------

function paymentsInRange(from, to) {
  const labels = sectionLabels();
  return db.prepare(`
    SELECT p.*, s.name AS student_name, s.section_id, u.name AS collected_by_name,
           (SELECT group_concat(month) FROM (SELECT month FROM payment_months WHERE payment_id = p.id ORDER BY month)) AS months,
           (SELECT group_concat(c.title, ', ') FROM payment_charges pc JOIN charges c ON c.id = pc.charge_id
             WHERE pc.payment_id = p.id) AS charge_titles
    FROM payments p
    JOIN students s ON s.id = p.student_id
    LEFT JOIN users u ON u.id = p.collected_by
    WHERE p.paid_on BETWEEN ? AND ?
    ORDER BY p.paid_on DESC, p.id DESC
  `).all(from, to).map((p) => ({
    ...p,
    label: labels.get(p.section_id),
    monthsText: [monthsSummary(p.months ? p.months.split(',') : []), p.charge_titles].filter(Boolean).join(', '),
  }));
}

// Everything the Payments page and its exports need for one date range.
function reportData(query) {
  const period = resolveRange(query);
  const payments = paymentsInRange(period.from, period.to);
  const valid = payments.filter((p) => !p.voided);
  const sum = (rows) => rows.reduce((n, p) => n + p.amount, 0);
  return {
    period,
    periodLabel: rangeLabel(period),
    payments,
    totals: {
      all: sum(valid),
      cash: sum(valid.filter((p) => p.method === 'Cash')),
      upi: sum(valid.filter((p) => p.method === 'UPI')),
      count: valid.length,
    },
    filename: `payments_${period.from === period.to ? period.from : `${period.from}_to_${period.to}`}`,
  };
}

router.get('/payments', (req, res) => {
  const data = reportData(req.query);
  const exportQuery = rangeQuery(data.period);
  res.render('payments', {
    title: 'Payments', ranges: RANGES, exportQuery, ...data,
  });
});

router.get('/payments.pdf', (req, res) => {
  const data = reportData(req.query);
  track(req.user, 'report_exported', { report: 'payments', format: 'pdf', range: data.period.range });
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${data.filename}.pdf"`,
  });
  writePaymentsPdf(res, { ...data, settings: getSettings() });
});

router.get('/payments.xlsx', async (req, res, next) => {
  const data = reportData(req.query);
  track(req.user, 'report_exported', { report: 'payments', format: 'xlsx', range: data.period.range });
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${data.filename}.xlsx"`,
  });
  try {
    await writePaymentsXlsx(res, { ...data, settings: getSettings() });
    res.end();
  } catch (err) {
    next(err);
  }
});

router.get('/payments.csv', (req, res) => {
  const { payments, filename } = reportData(req.query);
  const lines = [csvRow(['Receipt No', 'Date', 'Student', 'Class', 'Amount', 'Method', 'Fee months', 'Collected by', 'Note', 'Status', 'Void reason'])];
  for (const p of [...payments].reverse()) {
    lines.push(csvRow([
      p.receipt_no, p.paid_on, p.student_name, p.label, p.amount, p.method, p.monthsText,
      p.collected_by_name, p.note, p.voided ? 'VOID' : 'OK', p.void_reason,
    ]));
  }
  res.set({
    'Content-Type': 'text/csv; charset=utf-8',
    'Content-Disposition': `attachment; filename="${filename}.csv"`,
  });
  res.send(`﻿${lines.join('\r\n')}\r\n`);
});

module.exports = router;

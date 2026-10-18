const express = require('express');
const { db, getSections, getSettings } = require('../db');
const { requireAdmin } = require('../lib/auth');
const { buildLedgers, ledgerFor, monthlyFee, allocate } = require('../lib/ledger');
const { writeReceipt } = require('../lib/receipt');
const { writePaymentsPdf, writePaymentsXlsx } = require('../lib/report');
const {
  today, currentMonth, addMonths, addDays, lastDayOfMonth, monthsSummary, isDate, isMonth, dateLabel,
} = require('../lib/dates');
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
  try {
    paymentId = db.transaction(() => {
      const parts = allocate(student.id, amount);
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
      const insertPart = db.prepare('INSERT INTO payment_months (payment_id, month, amount) VALUES (?, ?, ?)');
      for (const p of parts) insertPart.run(id, p.month, p.amount);
      return id;
    })();
  } catch (err) {
    if (err.userFacing) return renderCollectForm(res, student, form, err.message, 400);
    throw err;
  }
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
  const months = db.prepare('SELECT month, amount FROM payment_months WHERE payment_id = ? ORDER BY month').all(payment.id);
  return { payment, student, months, label: sectionLabels().get(student.section_id) };
}

router.get('/payments/:id(\\d+)', (req, res) => {
  const data = loadPayment(req.params.id);
  if (!data) return res.status(404).render('error', { title: 'Not found', message: 'Receipt not found.' });
  const { payment, student, months, label } = data;
  const center = res.locals.settings.center_name;
  const shareText = `Payment received: ${money(payment.amount)} from ${student.name} (Class ${label}) `
    + `for ${monthsSummary(months.map((m) => m.month))}. Receipt No: ${payment.receipt_no}, `
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
  const { payment, student, months, label } = data;
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
    months,
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
  req.flash('success', `Receipt ${data.payment.receipt_no} voided. The amount is pending again.`);
  res.redirect(`/payments/${data.payment.id}`);
});

// ---------- Payments report ----------

const RANGES = [
  ['today', 'Today'],
  ['yesterday', 'Yesterday'],
  ['7d', 'Last 7 days'],
  ['30d', 'Last 30 days'],
  ['this_month', 'This month'],
  ['last_month', 'Last month'],
];

// Turns ?range=... (or ?from=&to=, or the older ?month=) into an inclusive date range.
function resolveRange(query) {
  const t = today();
  const thisMonth = currentMonth();
  const lastMonth = addMonths(thisMonth, -1);
  const presets = {
    today: [t, t],
    yesterday: [addDays(t, -1), addDays(t, -1)],
    '7d': [addDays(t, -6), t],
    '30d': [addDays(t, -29), t],
    this_month: [`${thisMonth}-01`, t],
    last_month: [`${lastMonth}-01`, lastDayOfMonth(lastMonth)],
  };
  if (presets[query.range]) {
    const [from, to] = presets[query.range];
    return { range: query.range, from, to };
  }
  if (isDate(query.from) && isDate(query.to)) {
    const [from, to] = query.from <= query.to ? [query.from, query.to] : [query.to, query.from];
    return { range: 'custom', from, to: to > t ? t : to };
  }
  if (isMonth(query.month)) {
    return { range: 'custom', from: `${query.month}-01`, to: lastDayOfMonth(query.month) };
  }
  return { range: 'this_month', from: presets.this_month[0], to: t };
}

function rangeLabel({ from, to }) {
  return from === to ? dateLabel(from) : `${dateLabel(from)} – ${dateLabel(to)}`;
}

function paymentsInRange(from, to) {
  const labels = sectionLabels();
  return db.prepare(`
    SELECT p.*, s.name AS student_name, s.section_id, u.name AS collected_by_name,
           (SELECT group_concat(month) FROM (SELECT month FROM payment_months WHERE payment_id = p.id ORDER BY month)) AS months
    FROM payments p
    JOIN students s ON s.id = p.student_id
    LEFT JOIN users u ON u.id = p.collected_by
    WHERE p.paid_on BETWEEN ? AND ?
    ORDER BY p.paid_on DESC, p.id DESC
  `).all(from, to).map((p) => ({
    ...p,
    label: labels.get(p.section_id),
    monthsText: monthsSummary(p.months ? p.months.split(',') : []),
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
  const { period } = data;
  const exportQuery = period.range === 'custom'
    ? `from=${period.from}&to=${period.to}`
    : `range=${period.range}`;
  res.render('payments', {
    title: 'Payments', ranges: RANGES, exportQuery, ...data,
  });
});

router.get('/payments.pdf', (req, res) => {
  const data = reportData(req.query);
  res.set({
    'Content-Type': 'application/pdf',
    'Content-Disposition': `attachment; filename="${data.filename}.pdf"`,
  });
  writePaymentsPdf(res, { ...data, settings: getSettings() });
});

router.get('/payments.xlsx', async (req, res, next) => {
  const data = reportData(req.query);
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

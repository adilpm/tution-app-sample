const express = require('express');
const { db } = require('../db');
const { requireAdmin } = require('../lib/auth');
const { track } = require('../lib/analytics');
const {
  RANGES, resolveRange, rangeLabel,
} = require('../lib/ranges');
const {
  today, currentMonth, addMonths, monthRange, isDate,
} = require('../lib/dates');
const { money } = require('../lib/format');

const router = express.Router();
router.use('/expenses', requireAdmin);

const CATEGORIES = ['Rent', 'Salary', 'Electricity', 'Internet & phone', 'Stationery', 'Maintenance', 'Marketing', 'Other'];

router.get('/expenses', (req, res) => {
  const period = resolveRange(req.query);
  const expenses = db.prepare(`
    SELECT e.*, u.name AS created_by_name FROM expenses e LEFT JOIN users u ON u.id = e.created_by
    WHERE e.date BETWEEN ? AND ? ORDER BY e.date DESC, e.id DESC
  `).all(period.from, period.to);
  const spent = expenses.reduce((n, e) => n + e.amount, 0);
  const income = db.prepare('SELECT COALESCE(SUM(amount), 0) AS n FROM payments WHERE voided = 0 AND paid_on BETWEEN ? AND ?')
    .get(period.from, period.to).n;

  const byCategory = new Map();
  for (const e of expenses) byCategory.set(e.category, (byCategory.get(e.category) || 0) + e.amount);

  // Month-by-month income vs expenses for the last 6 months.
  const month = currentMonth();
  const from = addMonths(month, -5);
  const monthly = (sql) => new Map(db.prepare(sql).all(`${from}-01`).map((r) => [r.m, r.n]));
  const incomeByMonth = monthly('SELECT substr(paid_on, 1, 7) AS m, SUM(amount) AS n FROM payments WHERE voided = 0 AND paid_on >= ? GROUP BY 1');
  const spentByMonth = monthly('SELECT substr(date, 1, 7) AS m, SUM(amount) AS n FROM expenses WHERE date >= ? GROUP BY 1');
  const trend = monthRange(from, month).reverse().map((m) => {
    const inc = incomeByMonth.get(m) || 0;
    const exp = spentByMonth.get(m) || 0;
    return { month: m, income: inc, expense: exp, profit: inc - exp };
  });

  res.render('expenses', {
    title: 'Expenses',
    period,
    periodLabel: rangeLabel(period),
    ranges: RANGES,
    expenses,
    spent,
    income,
    categories: [...byCategory.entries()].sort((a, b) => b[1] - a[1]),
    trend,
    CATEGORIES,
    today: today(),
  });
});

router.post('/expenses', (req, res) => {
  const date = String(req.body.date || '');
  const category = String(req.body.category || '').trim().slice(0, 40);
  const amount = Number(req.body.amount);
  const note = String(req.body.note || '').trim().slice(0, 200) || null;
  if (!isDate(date) || date > today() || !category || !Number.isInteger(amount) || amount <= 0 || amount > 100000000) {
    req.flash('error', 'Enter a date (today or earlier), a category and a whole-rupee amount.');
  } else {
    db.prepare('INSERT INTO expenses (date, category, amount, note, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(date, category, amount, note, req.user.id);
    track(req.user, 'expense_added', { amount, category });
    req.flash('success', `${category} expense of ${money(amount)} saved.`);
  }
  res.redirect(`/expenses${req.body.back ? `?${req.body.back}` : ''}`);
});

router.post('/expenses/:id/delete', (req, res) => {
  const e = db.prepare('SELECT * FROM expenses WHERE id = ?').get(Number(req.params.id));
  if (e) {
    db.prepare('DELETE FROM expenses WHERE id = ?').run(e.id);
    req.flash('success', `Deleted ${e.category} expense of ${money(e.amount)}.`);
  }
  res.redirect('/expenses');
});

module.exports = router;

const express = require('express');
const { db, getSections } = require('../db');
const { buildLedgers } = require('../lib/ledger');
const { today, currentMonth, addMonths, monthRange } = require('../lib/dates');

const router = express.Router();

router.get('/', (req, res) => {
  if (req.user.role !== 'admin') return res.redirect('/attendance');

  const month = currentMonth();
  const todayStr = today();
  const sections = getSections();
  const sectionLabel = new Map(sections.map((s) => [s.id, s.label]));
  const students = new Map(db.prepare('SELECT id, name, section_id, status FROM students').all().map((s) => [s.id, s]));
  const ledgers = buildLedgers();

  // This month's fees: what is due vs. how much of it has been paid.
  const sectionStats = new Map(sections.map((s) => [s.id, { ...s, expected: 0, paid: 0, count: 0 }]));
  let expected = 0;
  let paidForMonth = 0;
  let totalPending = 0;
  const defaulters = [];
  for (const [id, ledger] of ledgers) {
    totalPending += ledger.pending;
    const cur = ledger.months.find((m) => m.month === month);
    if (cur) {
      const paid = Math.min(cur.paid, cur.charge);
      expected += cur.charge;
      paidForMonth += paid;
      const st = sectionStats.get(cur.section_id);
      if (st) {
        st.expected += cur.charge;
        st.paid += paid;
        st.count += 1;
      }
    }
    if (ledger.unpaidMonths.length >= 2) {
      const s = students.get(id);
      defaulters.push({ ...s, label: sectionLabel.get(s.section_id), pending: ledger.pending, months: ledger.unpaidMonths.length });
    }
  }
  defaulters.sort((a, b) => b.pending - a.pending);

  const cashStmt = db.prepare('SELECT COALESCE(SUM(amount), 0) AS total, COUNT(*) AS n FROM payments WHERE voided = 0 AND paid_on LIKE ?');
  const collectedMonth = cashStmt.get(`${month}%`);
  const collectedToday = cashStmt.get(todayStr);

  const trendFrom = addMonths(month, -5);
  const trendTotals = new Map(db.prepare(`
    SELECT substr(paid_on, 1, 7) AS month, SUM(amount) AS total
    FROM payments WHERE voided = 0 AND paid_on >= ? GROUP BY 1
  `).all(`${trendFrom}-01`).map((r) => [r.month, r.total]));
  const trend = monthRange(trendFrom, month).map((m) => ({ month: m, total: trendTotals.get(m) || 0 }));
  const trendMax = Math.max(1, ...trend.map((t) => t.total));

  const attendanceRows = db.prepare(`
    SELECT section_id, SUM(status = 'P') AS present, SUM(status = 'A') AS absent
    FROM attendance WHERE date = ? GROUP BY section_id
  `).all(todayStr);
  const attendance = {
    present: attendanceRows.reduce((n, r) => n + r.present, 0),
    absent: attendanceRows.reduce((n, r) => n + r.absent, 0),
    sectionsMarked: attendanceRows.length,
    sectionsTotal: sections.length,
  };

  const recent = db.prepare(`
    SELECT p.id, p.receipt_no, p.amount, p.method, p.paid_on, p.voided, s.name, s.section_id
    FROM payments p JOIN students s ON s.id = p.student_id
    ORDER BY p.id DESC LIMIT 6
  `).all().map((p) => ({ ...p, label: sectionLabel.get(p.section_id) }));

  const activeCount = [...students.values()].filter((s) => s.status === 'active').length;

  res.render('dashboard', {
    title: 'Dashboard',
    month,
    expected,
    paidForMonth,
    totalPending,
    collectedMonth,
    collectedToday,
    defaulters: defaulters.slice(0, 8),
    defaulterCount: defaulters.length,
    sectionStats: [...sectionStats.values()],
    trend,
    trendMax,
    attendance,
    recent,
    activeCount,
  });
});

router.get('/more', (req, res) => {
  res.render('more', { title: 'More' });
});

module.exports = router;

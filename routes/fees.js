// Dues report (who owes what, with WhatsApp reminders) and one-time fees
// applied to a whole class, section or the entire center.
const express = require('express');
const { db, getSections, getSettings } = require('../db');
const { requireAdmin } = require('../lib/auth');
const { buildLedgers, duesSummary } = require('../lib/ledger');
const { feeReminderLink } = require('../lib/messages');
const { track } = require('../lib/analytics');
const { writeTablePdf, writeTableXlsx } = require('../lib/report');
const { rupees } = require('../lib/pdf-kit');
const { currentMonth, isMonth, today } = require('../lib/dates');
const { money } = require('../lib/format');

const router = express.Router();
router.use(['/dues', '/dues.pdf', '/dues.xlsx', '/fees'], requireAdmin);

// ---------- Dues ----------

function duesData(query) {
  const sections = getSections();
  const labels = new Map(sections.map((s) => [s.id, s.label]));
  const order = new Map(sections.map((s, i) => [s.id, i]));
  const section = Number(query.section) || null;
  const min = [2, 3].includes(Number(query.min)) ? Number(query.min) : 1;

  const students = db.prepare('SELECT * FROM students').all();
  const ledgers = buildLedgers();
  const rows = [];
  for (const s of students) {
    const l = ledgers.get(s.id);
    if (!l || l.pending <= 0) continue;
    if (section && s.section_id !== section) continue;
    if (min > 1 && l.unpaidMonths.length < min) continue;
    const label = labels.get(s.section_id);
    rows.push({
      id: s.id,
      name: s.name,
      parent: s.parent_name || '',
      phone: s.phone || '',
      status: s.status,
      section_id: s.section_id,
      label,
      pending: l.pending,
      months: l.unpaidMonths.length,
      dues: duesSummary(l),
      reminder: feeReminderLink(s, label, l),
    });
  }
  rows.sort((a, b) => b.pending - a.pending || order.get(a.section_id) - order.get(b.section_id) || a.name.localeCompare(b.name));

  const sectionName = section ? `Class ${labels.get(section)}` : 'All classes';
  const filterLabel = `${sectionName}${min > 1 ? ` · ${min}+ months overdue` : ''}`;
  return {
    sections,
    section,
    min,
    rows,
    filterLabel,
    total: rows.reduce((n, r) => n + r.pending, 0),
    query: [section ? `section=${section}` : '', min > 1 ? `min=${min}` : ''].filter(Boolean).join('&'),
  };
}

router.get('/dues', (req, res) => {
  res.render('dues', { title: 'Dues', ...duesData(req.query), today: today() });
});

const duesFilename = (d) => `dues_${today()}${d.section ? `_${d.rows[0]?.label || d.section}` : ''}`;

router.get('/dues.pdf', (req, res) => {
  const d = duesData(req.query);
  track(req.user, 'report_exported', { report: 'dues', format: 'pdf' });
  res.set({ 'Content-Type': 'application/pdf', 'Content-Disposition': `attachment; filename="${duesFilename(d)}.pdf"` });
  writeTablePdf(res, {
    title: 'Pending dues',
    subtitle: d.filterLabel,
    settings: getSettings(),
    summary: [['Total pending', rupees(d.total)], ['Students', String(d.rows.length)]],
    columns: [
      { title: 'Student', w: 120 }, { title: 'Class', w: 40 }, { title: 'Parent', w: 90 },
      { title: 'Phone', w: 78 }, { title: 'Pending for', w: 120 }, { title: 'Amount', align: 'right' },
    ],
    rows: d.rows.map((r) => ({ cells: [r.name, r.label, r.parent, r.phone, r.dues, rupees(r.pending)] })),
    total: { label: `TOTAL (${d.rows.length} students)`, value: rupees(d.total) },
    empty: 'Nobody has pending fees.',
  });
});

router.get('/dues.xlsx', async (req, res, next) => {
  const d = duesData(req.query);
  track(req.user, 'report_exported', { report: 'dues', format: 'xlsx' });
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': `attachment; filename="${duesFilename(d)}.xlsx"`,
  });
  try {
    await writeTableXlsx(res, {
      name: 'Dues',
      title: 'Pending dues',
      subtitle: d.filterLabel,
      settings: getSettings(),
      columns: [
        { header: 'Student', width: 26 }, { header: 'Class', width: 8 }, { header: 'Parent', width: 22 },
        { header: 'Phone', width: 15 }, { header: 'Months unpaid', width: 9 },
        { header: 'Pending for', width: 34 }, { header: 'Amount', width: 12, type: 'money' },
      ],
      rows: d.rows.map((r) => ({ values: [r.name, r.label, r.parent, r.phone, r.months, r.dues, r.pending] })),
      summary: [['Total pending', d.total], ['Students', d.rows.length]],
    });
    res.end();
  } catch (err) {
    next(err);
  }
});

// ---------- One-time fees for many students ----------

function recentBatches() {
  return db.prepare(`
    SELECT c.title, c.month, c.amount, date(c.created_at) AS added_on, COUNT(*) AS students,
           COALESCE(SUM((SELECT SUM(pc.amount) FROM payment_charges pc JOIN payments p ON p.id = pc.payment_id
                         WHERE pc.charge_id = c.id AND p.voided = 0)), 0) AS collected
    FROM charges c WHERE c.voided = 0
    GROUP BY c.title, c.month, c.amount, date(c.created_at)
    ORDER BY MAX(c.id) DESC LIMIT 20
  `).all();
}

router.get('/fees', (req, res) => {
  const sections = getSections();
  const classes = [...new Map(sections.map((s) => [s.class_id, { id: s.class_id, name: s.class_name }])).values()];
  res.render('fees', {
    title: 'One-time fees', sections, classes, batches: recentBatches(), month: currentMonth(),
  });
});

router.post('/fees', (req, res) => {
  const title = String(req.body.title || '').trim().slice(0, 80);
  const amount = Number(req.body.amount);
  const month = isMonth(req.body.month) ? req.body.month : currentMonth();
  const [kind, rawId] = String(req.body.target || '').split(':');
  const id = Number(rawId);
  if (!title || !Number.isInteger(amount) || amount <= 0 || amount > 10000000 || !['all', 'class', 'section'].includes(kind)) {
    req.flash('error', 'Enter a fee name, a whole-rupee amount and who it applies to.');
    return res.redirect('/fees');
  }

  const where = { all: '', class: 'AND sec.class_id = ?', section: 'AND st.section_id = ?' }[kind];
  const students = db.prepare(`
    SELECT st.id FROM students st JOIN sections sec ON sec.id = st.section_id
    WHERE st.status = 'active' ${where}
  `).all(...(kind === 'all' ? [] : [id]));

  // Skip students who already have this exact fee, so a double submit is harmless.
  const exists = db.prepare('SELECT 1 FROM charges WHERE student_id = ? AND title = ? AND month = ? AND voided = 0');
  const insert = db.prepare('INSERT INTO charges (student_id, title, amount, month, created_by) VALUES (?, ?, ?, ?, ?)');
  let added = 0;
  db.transaction(() => {
    for (const s of students) {
      if (exists.get(s.id, title, month)) continue;
      insert.run(s.id, title, amount, month, req.user.id);
      added += 1;
    }
  })();
  const skipped = students.length - added;
  track(req.user, 'one_time_fee_added', { amount, applied_to: kind, students: added });
  req.flash('success', `${title} of ${money(amount)} added for ${added} student${added === 1 ? '' : 's'}`
    + `${skipped ? ` (${skipped} already had it)` : ''}.`);
  res.redirect('/fees');
});

module.exports = router;

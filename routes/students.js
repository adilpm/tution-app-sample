const express = require('express');
const { db, getSections } = require('../db');
const { requireAdmin } = require('../lib/auth');
const {
  buildLedgers, ledgerFor, monthlyFee, paymentLines, duesSummary,
} = require('../lib/ledger');
const { feeReminderLink } = require('../lib/messages');
const { track } = require('../lib/analytics');
const {
  today, currentMonth, billingStartFor, isDate, isMonth,
} = require('../lib/dates');
const { money } = require('../lib/format');

const router = express.Router();
router.use('/students', requireAdmin);

const clean = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);

function parseStudent(body, sections) {
  const errors = [];
  const data = {
    name: clean(body.name, 100),
    parent_name: clean(body.parent_name, 100) || null,
    phone: clean(body.phone, 20) || null,
    section_id: Number(body.section_id),
    join_date: clean(body.join_date, 10),
    billing_start: clean(body.billing_start, 7),
    notes: clean(body.notes, 1000) || null,
  };
  if (!data.name) errors.push('Name is required.');
  if (data.phone && !/^[+\d][\d\s-]{6,19}$/.test(data.phone)) errors.push('Phone number looks wrong.');
  if (!sections.some((s) => s.id === data.section_id)) errors.push('Choose a class and division.');
  if (!isDate(data.join_date)) errors.push('Join date is required.');
  if (!data.billing_start && isDate(data.join_date)) data.billing_start = billingStartFor(data.join_date);
  if (!isMonth(data.billing_start)) errors.push('Billing start month is invalid.');
  return { data, errors };
}

router.get('/students', (req, res) => {
  const sections = getSections();
  const sectionLabel = new Map(sections.map((s) => [s.id, s.label]));
  const q = clean(req.query.q, 100);
  const section = Number(req.query.section) || null;
  const status = ['active', 'left', 'passed', 'all'].includes(req.query.status) ? req.query.status : 'active';
  const onlyPending = req.query.filter === 'pending';

  const where = [];
  const params = [];
  if (status !== 'all') { where.push('status = ?'); params.push(status); }
  if (section) { where.push('section_id = ?'); params.push(section); }
  if (q) {
    where.push('(name LIKE ? OR parent_name LIKE ? OR phone LIKE ?)');
    params.push(`%${q}%`, `%${q}%`, `%${q}%`);
  }
  let students = db.prepare(`SELECT * FROM students ${where.length ? `WHERE ${where.join(' AND ')}` : ''}`).all(...params);
  const ledgers = buildLedgers({ studentIds: students.map((s) => s.id) });
  students = students.map((s) => ({
    ...s,
    label: sectionLabel.get(s.section_id),
    pending: ledgers.get(s.id)?.pending || 0,
    unpaid: ledgers.get(s.id)?.unpaidMonths.length || 0,
  }));
  if (onlyPending) students = students.filter((s) => s.pending > 0);
  const order = new Map(sections.map((s, i) => [s.id, i]));
  students.sort((a, b) => (onlyPending ? b.pending - a.pending : 0)
    || order.get(a.section_id) - order.get(b.section_id)
    || a.name.localeCompare(b.name));

  res.render('students/list', {
    title: 'Students', students, sections, q, section, status, onlyPending,
  });
});

router.get('/students/new', (req, res) => {
  const sections = getSections();
  res.render('students/form', {
    title: 'Add student',
    sections,
    student: { join_date: today(), section_id: Number(req.query.section) || null },
    errors: [],
    isNew: true,
  });
});

router.post('/students', (req, res) => {
  const sections = getSections();
  const { data, errors } = parseStudent(req.body, sections);
  if (errors.length) {
    return res.status(400).render('students/form', {
      title: 'Add student', sections, student: data, errors, isNew: true,
    });
  }
  const id = db.transaction(() => {
    const newId = db.prepare(`
      INSERT INTO students (name, parent_name, phone, section_id, join_date, billing_start, notes)
      VALUES (@name, @parent_name, @phone, @section_id, @join_date, @billing_start, @notes)
    `).run(data).lastInsertRowid;
    db.prepare('INSERT INTO enrollments (student_id, section_id, from_month) VALUES (?, ?, ?)')
      .run(newId, data.section_id, data.billing_start);
    return newId;
  })();
  track(req.user, 'student_added', { class: sections.find((s) => s.id === data.section_id)?.label });
  req.flash('success', `${data.name} added.`);
  res.redirect(req.body.another ? `/students/new?section=${data.section_id}` : `/students/${id}`);
});

function loadStudent(req, res, next) {
  const student = db.prepare('SELECT * FROM students WHERE id = ?').get(Number(req.params.id));
  if (!student) return res.status(404).render('error', { title: 'Not found', message: 'Student not found.' });
  req.student = student;
  next();
}

router.get('/students/:id', loadStudent, (req, res) => {
  const s = req.student;
  const sections = getSections();
  const label = sections.find((x) => x.id === s.section_id)?.label;
  const ledger = ledgerFor(s.id);

  const payments = db.prepare('SELECT * FROM payments WHERE student_id = ? ORDER BY paid_on DESC, id DESC').all(s.id)
    .map((p) => ({ ...p, months: paymentLines(p.id).map((l) => l.label).join(', ') }));

  const att = db.prepare(`
    SELECT COUNT(*) AS total, COALESCE(SUM(status = 'P'), 0) AS present,
           COALESCE(SUM(status = 'P' AND date LIKE @m), 0) AS monthPresent,
           COALESCE(SUM(date LIKE @m), 0) AS monthTotal
    FROM attendance WHERE student_id = @id
  `).get({ id: s.id, m: `${currentMonth()}%` });
  const absences = db.prepare("SELECT date FROM attendance WHERE student_id = ? AND status = 'A' ORDER BY date DESC LIMIT 10")
    .all(s.id).map((r) => r.date);

  res.render('students/profile', {
    title: s.name,
    student: s,
    label,
    ledger,
    dues: duesSummary(ledger),
    fee: monthlyFee(s),
    months: [...ledger.months].reverse(),
    payments,
    att,
    absences,
    reminder: feeReminderLink(s, label, ledger),
    month: currentMonth(),
  });
});

// ---------- One-time fees on one student ----------

router.post('/students/:id/charges', loadStudent, (req, res) => {
  const title = clean(req.body.title, 80);
  const amount = Number(req.body.amount);
  const month = isMonth(req.body.month) ? req.body.month : currentMonth();
  if (!title || !Number.isInteger(amount) || amount <= 0 || amount > 10000000) {
    req.flash('error', 'Enter a name and a whole-rupee amount for the fee.');
  } else {
    db.prepare('INSERT INTO charges (student_id, title, amount, month, created_by) VALUES (?, ?, ?, ?, ?)')
      .run(req.student.id, title, amount, month, req.user.id);
    track(req.user, 'one_time_fee_added', { amount, applied_to: 'student', students: 1 });
    req.flash('success', `${title} of ${money(amount)} added.`);
  }
  res.redirect(`/students/${req.student.id}`);
});

router.post('/students/:id/charges/:chargeId/remove', loadStudent, (req, res) => {
  const charge = db.prepare('SELECT * FROM charges WHERE id = ? AND student_id = ? AND voided = 0')
    .get(Number(req.params.chargeId), req.student.id);
  const paid = charge && db.prepare(`
    SELECT COALESCE(SUM(pc.amount), 0) AS n FROM payment_charges pc JOIN payments p ON p.id = pc.payment_id
    WHERE pc.charge_id = ? AND p.voided = 0
  `).get(charge.id).n;
  if (!charge) {
    req.flash('error', 'Fee not found.');
  } else if (paid > 0) {
    req.flash('error', 'Part of this fee has been paid. Void that receipt first, then remove the fee.');
  } else {
    db.prepare('UPDATE charges SET voided = 1 WHERE id = ?').run(charge.id);
    req.flash('success', `${charge.title} removed.`);
  }
  res.redirect(`/students/${req.student.id}`);
});

router.get('/students/:id/edit', loadStudent, (req, res) => {
  res.render('students/form', {
    title: `Edit ${req.student.name}`, sections: getSections(), student: req.student, errors: [], isNew: false,
  });
});

router.post('/students/:id', loadStudent, (req, res) => {
  const sections = getSections();
  const { data, errors } = parseStudent(req.body, sections);
  const status = ['active', 'left', 'passed'].includes(req.body.status) ? req.body.status : 'active';
  let billingEnd = null;
  if (status !== 'active') {
    billingEnd = clean(req.body.billing_end, 7) || currentMonth();
    if (!isMonth(billingEnd)) errors.push('Last billed month is invalid.');
  }
  if (errors.length) {
    return res.status(400).render('students/form', {
      title: `Edit ${req.student.name}`, sections, student: { ...req.student, ...data, status, billing_end: billingEnd }, errors, isNew: false,
    });
  }

  db.transaction(() => {
    db.prepare(`
      UPDATE students SET name = @name, parent_name = @parent_name, phone = @phone, section_id = @section_id,
        join_date = @join_date, billing_start = @billing_start, notes = @notes,
        status = @status, billing_end = @billing_end
      WHERE id = @id
    `).run({ ...data, status, billing_end: billingEnd, id: req.student.id });

    if (data.section_id !== req.student.section_id) {
      if (req.body.section_change === 'correction') {
        // Wrong section entered originally: rewrite history.
        db.prepare('DELETE FROM enrollments WHERE student_id = ?').run(req.student.id);
        db.prepare('INSERT INTO enrollments (student_id, section_id, from_month) VALUES (?, ?, ?)')
          .run(req.student.id, data.section_id, data.billing_start);
      } else {
        db.prepare(`
          INSERT INTO enrollments (student_id, section_id, from_month) VALUES (?, ?, ?)
          ON CONFLICT (student_id, from_month) DO UPDATE SET section_id = excluded.section_id
        `).run(req.student.id, data.section_id, currentMonth());
      }
    }
  })();
  req.flash('success', 'Student updated.');
  res.redirect(`/students/${req.student.id}`);
});

router.post('/students/:id/delete', loadStudent, (req, res) => {
  const hasPayments = db.prepare('SELECT 1 FROM payments WHERE student_id = ? LIMIT 1').get(req.student.id);
  if (hasPayments) {
    req.flash('error', 'This student has payments, so they cannot be deleted. Mark them as "Left" instead.');
    return res.redirect(`/students/${req.student.id}/edit`);
  }
  db.prepare('DELETE FROM students WHERE id = ?').run(req.student.id);
  req.flash('success', `${req.student.name} deleted.`);
  res.redirect('/students');
});

module.exports = router;

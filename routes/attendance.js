const express = require('express');
const { db, getSections } = require('../db');
const { absenceAlertLink } = require('../lib/messages');
const {
  today, currentMonth, isDate, isMonth, dateLabel,
} = require('../lib/dates');

const router = express.Router();

const asList = (v) => (v == null ? [] : Array.isArray(v) ? v : [v]).map(Number);
const pickDate = (d) => (isDate(d) && d <= today() ? d : today());

// Sections this user may mark: everything for admins and for teachers with no
// assignment, otherwise only the assigned ones.
function visibleSections(user) {
  const sections = getSections();
  if (user.role === 'admin') return sections;
  const assigned = new Set(db.prepare('SELECT section_id FROM teacher_sections WHERE user_id = ?').all(user.id).map((r) => r.section_id));
  return assigned.size ? sections.filter((s) => assigned.has(s.id)) : sections;
}

function findSection(id, user) {
  return visibleSections(user).find((s) => s.id === Number(id));
}

const notFound = (res) => res.status(404).render('error', { title: 'Not found', message: 'Section not found.' });

function sectionStudents(sectionId, date) {
  return db.prepare(`
    SELECT id, name FROM students
    WHERE section_id = ? AND status = 'active' AND join_date <= ?
    ORDER BY name
  `).all(sectionId, date);
}

router.get('/attendance', (req, res) => {
  const date = pickDate(req.query.date);
  const counts = new Map(db.prepare(`
    SELECT section_id, SUM(status = 'P') AS present, SUM(status = 'A') AS absent
    FROM attendance WHERE date = ? GROUP BY section_id
  `).all(date).map((r) => [r.section_id, r]));
  const sizes = new Map(db.prepare(`
    SELECT section_id, COUNT(*) AS n FROM students WHERE status = 'active' GROUP BY section_id
  `).all().map((r) => [r.section_id, r.n]));

  const classes = [];
  for (const s of visibleSections(req.user)) {
    let group = classes.find((c) => c.grade === s.grade);
    if (!group) {
      group = { grade: s.grade, name: s.class_name, sections: [] };
      classes.push(group);
    }
    group.sections.push({ ...s, students: sizes.get(s.id) || 0, marked: counts.get(s.id) || null });
  }
  res.render('attendance/index', { title: 'Attendance', date, classes, isToday: date === today() });
});

router.get('/attendance/:sectionId(\\d+)', (req, res) => {
  const section = findSection(req.params.sectionId, req.user);
  if (!section) return notFound(res);
  const date = pickDate(req.query.date);
  const marks = new Map(db.prepare('SELECT student_id, status FROM attendance WHERE section_id = ? AND date = ?')
    .all(section.id, date).map((r) => [r.student_id, r.status]));
  const students = sectionStudents(section.id, date).map((s) => ({ ...s, status: marks.get(s.id) || null }));
  res.render('attendance/mark', {
    title: `Attendance ${section.label}`, section, date, students, alreadyMarked: marks.size > 0,
  });
});

router.post('/attendance/:sectionId(\\d+)', (req, res) => {
  const section = findSection(req.params.sectionId, req.user);
  if (!section) return notFound(res);
  const date = req.body.date;
  if (!isDate(date) || date > today()) {
    req.flash('error', 'Attendance can only be marked for today or earlier.');
    return res.redirect(`/attendance/${section.id}`);
  }
  const valid = new Set(sectionStudents(section.id, date).map((s) => s.id));
  const absent = new Set(asList(req.body.absent));
  const ids = asList(req.body.student).filter((id) => valid.has(id));

  const upsert = db.prepare(`
    INSERT INTO attendance (student_id, date, section_id, status, marked_by) VALUES (?, ?, ?, ?, ?)
    ON CONFLICT (student_id, date) DO UPDATE SET
      status = excluded.status, section_id = excluded.section_id,
      marked_by = excluded.marked_by, marked_at = CURRENT_TIMESTAMP
  `);
  db.transaction(() => {
    for (const id of ids) upsert.run(id, date, section.id, absent.has(id) ? 'A' : 'P', req.user.id);
  })();

  const absentCount = ids.filter((id) => absent.has(id)).length;
  req.flash('success', `${section.label} saved for ${dateLabel(date)}: ${ids.length - absentCount} present, ${absentCount} absent.`);
  // With absentees, go straight to the parent alerts.
  res.redirect(absentCount ? `/attendance/${section.id}/absent?date=${date}` : `/attendance?date=${date}`);
});

router.get('/attendance/:sectionId(\\d+)/absent', (req, res) => {
  const section = findSection(req.params.sectionId, req.user);
  if (!section) return notFound(res);
  const date = pickDate(req.query.date);
  const absentees = db.prepare(`
    SELECT s.id, s.name, s.parent_name, s.phone FROM attendance a JOIN students s ON s.id = a.student_id
    WHERE a.section_id = ? AND a.date = ? AND a.status = 'A' ORDER BY s.name
  `).all(section.id, date).map((s) => ({ ...s, alert: absenceAlertLink(s, section.label, date) }));
  res.render('attendance/absent', {
    title: `Absent in ${section.label}`, section, date, absentees,
  });
});

router.get('/attendance/:sectionId(\\d+)/report', (req, res) => {
  const section = findSection(req.params.sectionId, req.user);
  if (!section) return notFound(res);
  const month = isMonth(req.query.month) ? req.query.month : currentMonth();

  const rows = db.prepare(`
    SELECT a.student_id, a.date, a.status FROM attendance a
    WHERE a.section_id = ? AND a.date LIKE ? ORDER BY a.date
  `).all(section.id, `${month}%`);
  const days = [...new Set(rows.map((r) => r.date))];

  const byStudent = new Map();
  for (const r of rows) {
    if (!byStudent.has(r.student_id)) byStudent.set(r.student_id, { present: 0, absent: 0, absentDates: [] });
    const s = byStudent.get(r.student_id);
    if (r.status === 'P') s.present += 1;
    else {
      s.absent += 1;
      s.absentDates.push(r.date);
    }
  }
  // Current members of the section plus anyone who has marks in it this month.
  const ids = new Set([...sectionStudents(section.id, `${month}-31`).map((s) => s.id), ...byStudent.keys()]);
  const students = ids.size
    ? db.prepare(`SELECT id, name FROM students WHERE id IN (${[...ids].map(() => '?').join(',')}) ORDER BY name`).all(...ids)
    : [];
  const report = students.map((s) => {
    const r = byStudent.get(s.id) || { present: 0, absent: 0, absentDates: [] };
    const total = r.present + r.absent;
    return { ...s, ...r, pct: total ? Math.round((r.present / total) * 100) : null };
  });

  res.render('attendance/report', {
    title: `Attendance report ${section.label}`, section, month, days, report,
  });
});

module.exports = router;

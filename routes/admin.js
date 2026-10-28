const path = require('path');
const fs = require('fs');
const express = require('express');
const {
  db, dataDir, ordinal, getSections, getSetting, setSetting,
} = require('../db');
const { requireAdmin, hashPassword } = require('../lib/auth');
const { logoPath } = require('../lib/pdf-kit');
const {
  currentMonth, addMonths, isMonth, monthLabel, today,
} = require('../lib/dates');

const router = express.Router();
router.use(['/settings', '/users', '/promote', '/backup', '/classes'], requireAdmin);

const clean = (v, max = 200) => String(v == null ? '' : v).trim().slice(0, max);

// ---------- Settings & fees ----------

function feeRates() {
  const classes = db.prepare('SELECT * FROM classes ORDER BY grade').all();
  const rates = db.prepare('SELECT * FROM fee_rates ORDER BY effective_from DESC').all();
  const month = currentMonth();
  return classes.map((c) => {
    const history = rates.filter((r) => r.class_id === c.id);
    const current = history.find((r) => r.effective_from <= month) || history[history.length - 1];
    return { ...c, history, current };
  });
}

router.get('/settings', (req, res) => {
  res.render('settings', {
    title: 'Settings',
    hasLogo: !!logoPath(),
    classes: feeRates(),
    skip: new Set((getSetting('skip_months') || '').split(',').filter(Boolean)),
    month: currentMonth(),
  });
});

router.post('/settings', (req, res) => {
  setSetting('center_name', clean(req.body.center_name, 100) || 'My Tuition Center');
  setSetting('center_address', clean(req.body.center_address, 200));
  setSetting('center_phone', clean(req.body.center_phone, 50));
  const skip = (Array.isArray(req.body.skip) ? req.body.skip : [req.body.skip])
    .filter((m) => /^(0[1-9]|1[0-2])$/.test(m));
  setSetting('skip_months', [...new Set(skip)].sort().join(','));
  req.flash('success', 'Settings saved.');
  res.redirect('/settings');
});

router.post('/settings/fees', (req, res) => {
  const classId = Number(req.body.class_id);
  const amount = Number(req.body.amount);
  const from = clean(req.body.effective_from, 7);
  if (!db.prepare('SELECT 1 FROM classes WHERE id = ?').get(classId)
    || !Number.isInteger(amount) || amount <= 0 || !isMonth(from)) {
    req.flash('error', 'Enter a valid class, amount and starting month.');
    return res.redirect('/settings');
  }
  db.prepare(`
    INSERT INTO fee_rates (class_id, amount, effective_from) VALUES (?, ?, ?)
    ON CONFLICT (class_id, effective_from) DO UPDATE SET amount = excluded.amount
  `).run(classId, amount, from);
  req.flash('success', `Fee updated from ${monthLabel(from)}.`);
  res.redirect('/settings');
});

router.post('/settings/fees/:id/delete', (req, res) => {
  const rate = db.prepare('SELECT * FROM fee_rates WHERE id = ?').get(Number(req.params.id));
  const count = rate ? db.prepare('SELECT COUNT(*) AS n FROM fee_rates WHERE class_id = ?').get(rate.class_id).n : 0;
  if (!rate || count <= 1) {
    req.flash('error', 'Each class needs at least one fee.');
  } else {
    db.prepare('DELETE FROM fee_rates WHERE id = ?').run(rate.id);
    req.flash('success', 'Fee change removed.');
  }
  res.redirect('/settings');
});

// ---------- Logo ----------

const LOGO_TYPES = {
  png: { mime: 'image/png', magic: [0x89, 0x50, 0x4e, 0x47] },
  jpg: { mime: 'image/jpeg', magic: [0xff, 0xd8, 0xff] },
};

router.post('/settings/logo', (req, res) => {
  const match = /^data:image\/(png|jpeg);base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.logo || ''));
  const ext = match && (match[1] === 'png' ? 'png' : 'jpg');
  const buf = match ? Buffer.from(match[2], 'base64') : null;
  if (!buf || buf.length > 1024 * 1024 || !LOGO_TYPES[ext].magic.every((b, i) => buf[i] === b)) {
    req.flash('error', 'Choose a PNG or JPG image under 1 MB.');
    return res.redirect('/settings');
  }
  for (const e of Object.keys(LOGO_TYPES)) fs.rmSync(path.join(dataDir, `logo.${e}`), { force: true });
  fs.writeFileSync(path.join(dataDir, `logo.${ext}`), buf, { mode: 0o600 });
  req.flash('success', 'Logo saved. It now appears on receipts and reports.');
  res.redirect('/settings');
});

router.post('/settings/logo/remove', (req, res) => {
  for (const e of Object.keys(LOGO_TYPES)) fs.rmSync(path.join(dataDir, `logo.${e}`), { force: true });
  req.flash('success', 'Logo removed.');
  res.redirect('/settings');
});

// Any logged-in user (the sidebar shows it).
router.get('/logo', (req, res) => {
  const file = logoPath();
  if (!file) return res.status(404).end();
  res.set('Cache-Control', 'private, max-age=300');
  res.type(file.endsWith('.png') ? 'png' : 'jpeg').sendFile(file);
});

// ---------- Classes & divisions ----------

function classesOverview() {
  const counts = new Map(db.prepare(`
    SELECT section_id, SUM(status = 'active') AS active, COUNT(*) AS total FROM students GROUP BY section_id
  `).all().map((r) => [r.section_id, r]));
  const sections = getSections();
  return feeRates().map((c) => ({
    ...c,
    sections: sections.filter((s) => s.class_id === c.id).map((s) => ({
      ...s, active: counts.get(s.id)?.active || 0, total: counts.get(s.id)?.total || 0,
    })),
  }));
}

router.get('/classes', (req, res) => {
  res.render('classes', { title: 'Classes', classes: classesOverview() });
});

const cleanDivision = (v) => String(v || '').trim().toUpperCase();
const validDivision = (d) => /^[A-Z0-9]{1,3}$/.test(d);

router.post('/classes', (req, res) => {
  const grade = Number(req.body.grade);
  const fee = Number(req.body.fee);
  const divisions = [...new Set(String(req.body.divisions || '').split(/[\s,]+/).map(cleanDivision).filter(Boolean))];
  if (!Number.isInteger(grade) || grade < 1 || grade > 12) {
    req.flash('error', 'Class must be a number from 1 to 12.');
  } else if (db.prepare('SELECT 1 FROM classes WHERE grade = ?').get(grade)) {
    req.flash('error', `Class ${grade} already exists. Add divisions to it instead.`);
  } else if (!Number.isInteger(fee) || fee <= 0) {
    req.flash('error', 'Enter the monthly fee in whole rupees.');
  } else if (!divisions.length || !divisions.every(validDivision)) {
    req.flash('error', 'Enter divisions like: A, B, C (letters or numbers, up to 3 characters).');
  } else {
    db.transaction(() => {
      const classId = db.prepare('INSERT INTO classes (grade, name) VALUES (?, ?)').run(grade, ordinal(grade)).lastInsertRowid;
      for (const d of divisions) db.prepare('INSERT INTO sections (class_id, division) VALUES (?, ?)').run(classId, d);
      db.prepare('INSERT INTO fee_rates (class_id, amount, effective_from) VALUES (?, ?, ?)').run(classId, fee, '2000-01');
    })();
    req.flash('success', `${ordinal(grade)} added with ${divisions.length} division${divisions.length === 1 ? '' : 's'}.`);
  }
  res.redirect('/classes');
});

router.post('/classes/:id/sections', (req, res) => {
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(Number(req.params.id));
  const division = cleanDivision(req.body.division);
  if (!cls || !validDivision(division)) {
    req.flash('error', 'Enter a division like E (letters or numbers, up to 3 characters).');
  } else if (db.prepare('SELECT 1 FROM sections WHERE class_id = ? AND division = ?').get(cls.id, division)) {
    req.flash('error', `${cls.grade}${division} already exists.`);
  } else {
    db.prepare('INSERT INTO sections (class_id, division) VALUES (?, ?)').run(cls.id, division);
    req.flash('success', `${cls.grade}${division} added.`);
  }
  res.redirect('/classes');
});

// Only empty, never-used sections can go; anything with history stays.
router.post('/sections/:id/delete', requireAdmin, (req, res) => {
  const s = getSections().find((x) => x.id === Number(req.params.id));
  const used = s && ['students', 'enrollments', 'attendance'].some((t) => db.prepare(`SELECT 1 FROM ${t} WHERE section_id = ? LIMIT 1`).get(s.id));
  if (!s) {
    req.flash('error', 'Section not found.');
  } else if (used) {
    req.flash('error', `${s.label} has students or history, so it can't be deleted.`);
  } else {
    db.prepare('DELETE FROM sections WHERE id = ?').run(s.id);
    req.flash('success', `${s.label} deleted.`);
  }
  res.redirect('/classes');
});

router.post('/classes/:id/delete', (req, res) => {
  const cls = db.prepare('SELECT * FROM classes WHERE id = ?').get(Number(req.params.id));
  if (!cls) {
    req.flash('error', 'Class not found.');
  } else if (db.prepare('SELECT 1 FROM sections WHERE class_id = ?').get(cls.id)) {
    req.flash('error', `Delete ${cls.name}'s divisions first.`);
  } else {
    db.transaction(() => {
      db.prepare('DELETE FROM fee_rates WHERE class_id = ?').run(cls.id);
      db.prepare('DELETE FROM classes WHERE id = ?').run(cls.id);
    })();
    req.flash('success', `${cls.name} deleted.`);
  }
  res.redirect('/classes');
});

// ---------- Users ----------

function usersPage(res, error, status = 200) {
  const users = db.prepare('SELECT id, username, name, role, active FROM users ORDER BY role, name').all();
  const assigned = new Map();
  for (const r of db.prepare('SELECT user_id, section_id FROM teacher_sections').all()) {
    if (!assigned.has(r.user_id)) assigned.set(r.user_id, new Set());
    assigned.get(r.user_id).add(r.section_id);
  }
  res.status(status).render('users', {
    title: 'Users',
    users: users.map((u) => ({ ...u, sections: assigned.get(u.id) || new Set() })),
    sections: getSections(),
    error,
  });
}

router.get('/users', (req, res) => usersPage(res, null));

router.post('/users', (req, res) => {
  const username = clean(req.body.username, 40).toLowerCase();
  const name = clean(req.body.name, 100);
  const password = String(req.body.password || '');
  const role = req.body.role === 'admin' ? 'admin' : 'teacher';
  let error = null;
  if (!/^[a-z0-9._-]{3,40}$/.test(username)) error = 'Username: 3+ characters, letters/numbers only.';
  else if (!name) error = 'Name is required.';
  else if (password.length < 8) error = 'Password must be at least 8 characters.';
  else if (db.prepare('SELECT 1 FROM users WHERE username = ?').get(username)) error = 'That username is taken.';
  if (error) return usersPage(res, error, 400);
  db.prepare('INSERT INTO users (username, name, password_hash, role) VALUES (?, ?, ?, ?)')
    .run(username, name, hashPassword(password), role);
  req.flash('success', `User ${username} created.`);
  res.redirect('/users');
});

router.post('/users/:id', (req, res) => {
  const target = db.prepare('SELECT * FROM users WHERE id = ?').get(Number(req.params.id));
  if (!target) return res.redirect('/users');
  const activeAdmins = db.prepare("SELECT COUNT(*) AS n FROM users WHERE role = 'admin' AND active = 1").get().n;

  if (req.body.action === 'password') {
    const password = String(req.body.password || '');
    if (password.length < 8) {
      req.flash('error', 'Password must be at least 8 characters.');
    } else {
      db.prepare('UPDATE users SET password_hash = ? WHERE id = ?').run(hashPassword(password), target.id);
      db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ? AND sid != ?").run(target.id, req.sessionID);
      req.flash('success', `Password reset for ${target.username}.`);
    }
  } else if (req.body.action === 'sections') {
    const valid = new Set(getSections().map((s) => s.id));
    const chosen = (Array.isArray(req.body.section) ? req.body.section : [req.body.section])
      .map(Number).filter((id) => valid.has(id));
    db.transaction(() => {
      db.prepare('DELETE FROM teacher_sections WHERE user_id = ?').run(target.id);
      const add = db.prepare('INSERT INTO teacher_sections (user_id, section_id) VALUES (?, ?)');
      for (const id of chosen) add.run(target.id, id);
    })();
    req.flash('success', chosen.length
      ? `${target.name} can now mark ${chosen.length} section${chosen.length === 1 ? '' : 's'}.`
      : `${target.name} can now mark all sections.`);
  } else if (req.body.action === 'toggle') {
    if (target.id === req.user.id) {
      req.flash('error', 'You cannot disable your own account.');
    } else if (target.active && target.role === 'admin' && activeAdmins <= 1) {
      req.flash('error', 'Keep at least one active admin.');
    } else {
      db.prepare('UPDATE users SET active = ? WHERE id = ?').run(target.active ? 0 : 1, target.id);
      if (target.active) db.prepare("DELETE FROM sessions WHERE json_extract(sess, '$.userId') = ?").run(target.id);
      req.flash('success', `${target.username} ${target.active ? 'disabled' : 'enabled'}.`);
    }
  }
  res.redirect('/users');
});

// ---------- Year-end promotion ----------

function promotionPreview() {
  const sections = getSections();
  const counts = new Map(db.prepare("SELECT section_id, COUNT(*) AS n FROM students WHERE status = 'active' GROUP BY section_id")
    .all().map((r) => [r.section_id, r.n]));
  const grades = [...new Set(sections.map((s) => s.grade))].sort((a, b) => a - b);
  return grades.map((g, i) => ({
    grade: g,
    count: sections.filter((s) => s.grade === g).reduce((n, s) => n + (counts.get(s.id) || 0), 0),
    to: grades[i + 1] || null,
  }));
}

router.get('/promote', (req, res) => {
  res.render('promote', {
    title: 'Year-end promotion',
    preview: promotionPreview(),
    lastPromotion: getSetting('last_promotion'),
    month: currentMonth(),
    error: null,
  });
});

router.post('/promote', (req, res) => {
  const month = clean(req.body.effective_month, 7);
  const renderError = (error) => res.status(400).render('promote', {
    title: 'Year-end promotion', preview: promotionPreview(), lastPromotion: getSetting('last_promotion'), month: currentMonth(), error,
  });
  if (!isMonth(month)) return renderError('Choose the month the new academic year starts.');
  if (req.body.confirm !== 'PROMOTE') return renderError('Type PROMOTE in capitals to confirm.');
  const last = getSetting('last_promotion');
  if (last && last > addMonths(month, -6)) return renderError(`Students were already promoted from ${monthLabel(last)}.`);

  const sections = getSections();
  const grades = [...new Set(sections.map((s) => s.grade))].sort((a, b) => b - a);
  const result = { passed: 0, promoted: 0 };

  db.transaction(() => {
    const prev = addMonths(month, -1);
    const top = grades[0];
    // Highest class passes out; their billing stops the month before.
    for (const s of sections.filter((x) => x.grade === top)) {
      result.passed += db.prepare(`
        UPDATE students SET status = 'passed', billing_end = CASE WHEN billing_start > ? THEN billing_start ELSE ? END
        WHERE section_id = ? AND status = 'active'
      `).run(prev, prev, s.id).changes;
    }
    // Then move each lower class up one, keeping the same division.
    const enroll = db.prepare(`
      INSERT INTO enrollments (student_id, section_id, from_month) VALUES (?, ?, ?)
      ON CONFLICT (student_id, from_month) DO UPDATE SET section_id = excluded.section_id
    `);
    for (const grade of grades.slice(1)) {
      const next = grades[grades.indexOf(grade) - 1];
      for (const s of sections.filter((x) => x.grade === grade)) {
        const target = sections.find((x) => x.grade === next && x.division === s.division);
        if (!target) continue;
        const ids = db.prepare("SELECT id FROM students WHERE section_id = ? AND status = 'active'").all(s.id).map((r) => r.id);
        for (const id of ids) {
          db.prepare('UPDATE students SET section_id = ? WHERE id = ?').run(target.id, id);
          enroll.run(id, target.id, month);
        }
        result.promoted += ids.length;
      }
    }
    setSetting('last_promotion', month);
  })();

  req.flash('success', `Done: ${result.promoted} students promoted, ${result.passed} marked as passed out.`);
  res.redirect('/students');
});

// ---------- Backup ----------

router.get('/backup', async (req, res, next) => {
  // Written next to the database, not the shared /tmp, so other users on the
  // server can't read the copy.
  const file = path.join(dataDir, `download-backup-${Date.now()}.db`);
  try {
    await db.backup(file);
    res.download(file, `tuition-backup-${today()}.db`, (err) => {
      fs.unlink(file, () => {});
      if (err && !res.headersSent) next(err);
    });
  } catch (err) {
    fs.unlink(file, () => {});
    next(err);
  }
});

module.exports = router;

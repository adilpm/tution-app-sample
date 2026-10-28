// Bulk student import from an Excel (.xlsx) or CSV file: upload, preview with
// per-row problems, then confirm.
const { Readable } = require('stream');
const express = require('express');
const ExcelJS = require('exceljs');
const { db, getSections } = require('../db');
const { requireAdmin } = require('../lib/auth');
const { track } = require('../lib/analytics');
const { today, billingStartFor, isDate } = require('../lib/dates');

const router = express.Router();
router.use('/import', requireAdmin);

const MAX_ROWS = 1000;
const HEADERS = {
  name: ['name', 'student', 'student name', 'full name'],
  parent: ['parent', 'parent name', 'guardian', 'guardian name', 'father', 'mother', "father's name", "mother's name"],
  phone: ['phone', 'mobile', 'whatsapp', 'contact', 'phone number', 'mobile number', 'whatsapp number', "parent's phone"],
  class: ['class', 'grade', 'std', 'standard', 'class & division', 'class and division'],
  division: ['division', 'div', 'section'],
  join: ['join date', 'joined', 'joining date', 'date of joining', 'join', 'admission date'],
};

function cellText(v) {
  if (v == null) return '';
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  if (typeof v === 'object') {
    if (v.richText) return v.richText.map((t) => t.text).join('');
    if (v.text != null) return String(v.text);
    if (v.result != null) return cellText(v.result);
    return '';
  }
  return String(v).trim();
}

// Accepts 2026-06-01, 01-06-2026, 1/6/2026 (day first, as written in India).
function parseDate(s) {
  if (!s) return today();
  if (isDate(s)) return s;
  const m = /^(\d{1,2})[/.-](\d{1,2})[/.-](\d{4})$/.exec(s);
  if (!m) return null;
  const iso = `${m[3]}-${m[2].padStart(2, '0')}-${m[1].padStart(2, '0')}`;
  return isDate(iso) ? iso : null;
}

async function readRows(buf, filename) {
  const wb = new ExcelJS.Workbook();
  if (/\.csv$/i.test(filename)) await wb.csv.read(Readable.from(buf.toString('utf8').replace(/^﻿/, '')));
  else await wb.xlsx.load(buf);
  const ws = wb.worksheets[0];
  if (!ws) return { error: 'The file has no sheets.' };

  // The header row is the first row that names a "name" column.
  let headerRow = null;
  const cols = {};
  ws.eachRow((row, n) => {
    if (headerRow) return;
    const found = {};
    row.eachCell((cell, c) => {
      const h = cellText(cell.value).toLowerCase().replace(/\s+/g, ' ').trim();
      for (const [key, names] of Object.entries(HEADERS)) if (names.includes(h) && !found[key]) found[key] = c;
    });
    if (found.name) {
      headerRow = n;
      Object.assign(cols, found);
    }
  });
  if (!headerRow) return { error: 'Couldn\'t find a header row with a "Name" column. Use the template.' };
  if (!cols.class) return { error: 'Couldn\'t find a "Class" column. Use the template.' };

  const rows = [];
  ws.eachRow((row, n) => {
    if (n <= headerRow) return;
    const get = (key) => (cols[key] ? cellText(row.getCell(cols[key]).value) : '');
    const values = Object.fromEntries(Object.keys(HEADERS).map((k) => [k, get(k)]));
    if (Object.values(values).every((v) => !v)) return;
    rows.push({ line: n, ...values });
  });
  return { rows };
}

function validate(rawRows) {
  const sections = getSections();
  const byLabel = new Map(sections.map((s) => [s.label.toUpperCase(), s]));
  const existing = new Set(db.prepare("SELECT lower(name) || '|' || section_id AS k FROM students WHERE status = 'active'").all().map((r) => r.k));
  const seen = new Set();

  return rawRows.map((r) => {
    const problems = [];
    const name = r.name.slice(0, 100);
    // "8", "8th", "8 A", "8-A", "8A" — with or without a separate division column.
    const m = /^(\d{1,2})\s*(?:st|nd|rd|th)?\s*[-\s]?\s*([A-Za-z0-9]{0,3})$/i.exec(r.class.replace(/\s*std\.?$/i, '').trim());
    const division = (r.division || (m && m[2]) || '').toUpperCase();
    const section = m ? byLabel.get(`${Number(m[1])}${division}`) : null;
    const phone = r.phone.replace(/\.0$/, '');
    const joinDate = parseDate(r.join);

    if (!name) problems.push('Name missing');
    if (!section) problems.push(`Unknown class "${[r.class, r.division].filter(Boolean).join(' ')}"`);
    if (phone && !/^[+\d][\d\s-]{6,19}$/.test(phone)) problems.push('Phone looks wrong');
    if (!joinDate) problems.push(`Join date "${r.join}" not understood (use DD-MM-YYYY)`);

    const key = section ? `${name.toLowerCase()}|${section.id}` : null;
    let status = problems.length ? 'error' : 'ok';
    if (status === 'ok' && (existing.has(key) || seen.has(key))) {
      status = 'duplicate';
      problems.push(existing.has(key) ? 'Already in the app' : 'Repeated in the file');
    }
    if (key) seen.add(key);

    return {
      line: r.line,
      status,
      problems,
      name,
      parent_name: r.parent.slice(0, 100) || null,
      phone: phone || null,
      section_id: section ? section.id : null,
      label: section ? section.label : [r.class, r.division].filter(Boolean).join(' '),
      join_date: joinDate,
    };
  });
}

router.get('/import', (req, res) => {
  res.render('import/upload', { title: 'Import students', error: null });
});

router.get('/import/template.xlsx', async (req, res, next) => {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('Students');
  ws.columns = [
    { header: 'Name', width: 26 }, { header: 'Parent name', width: 24 }, { header: 'Phone', width: 16 },
    { header: 'Class', width: 8 }, { header: 'Division', width: 9 }, { header: 'Join date', width: 13 },
  ];
  ws.getRow(1).font = { bold: true };
  ws.addRow(['Aarav Nair', 'Suresh Nair', '9876543210', 8, 'A', '01-06-2026']);
  ws.addRow(['Diya Menon', 'Lakshmi Menon', '9876501234', 9, 'B', '15-06-2026']);
  ws.getColumn(3).numFmt = '@';
  ws.getColumn(6).numFmt = '@';
  res.set({
    'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
    'Content-Disposition': 'attachment; filename="students_template.xlsx"',
  });
  try {
    await wb.xlsx.write(res);
    res.end();
  } catch (err) {
    next(err);
  }
});

router.post('/import/preview', async (req, res) => {
  const fail = (error) => res.status(400).render('import/upload', { title: 'Import students', error });
  const filename = String(req.body.filename || '');
  const match = /^data:[^;]*;base64,([A-Za-z0-9+/=]+)$/.exec(String(req.body.file || ''));
  if (!match || !/\.(xlsx|csv)$/i.test(filename)) return fail('Choose an Excel (.xlsx) or CSV file.');

  let parsed;
  try {
    parsed = await readRows(Buffer.from(match[1], 'base64'), filename);
  } catch {
    return fail('That file could not be read. Save it as .xlsx or .csv and try again.');
  }
  if (parsed.error) return fail(parsed.error);
  if (!parsed.rows.length) return fail('No student rows found under the header row.');
  if (parsed.rows.length > MAX_ROWS) return fail(`At most ${MAX_ROWS} students per file.`);

  const rows = validate(parsed.rows);
  req.session.importRows = rows.filter((r) => r.status === 'ok')
    .map(({ name, parent_name, phone, section_id, join_date }) => ({ name, parent_name, phone, section_id, join_date }));
  res.render('import/preview', {
    title: 'Check import',
    filename,
    rows,
    ready: rows.filter((r) => r.status === 'ok').length,
    errors: rows.filter((r) => r.status === 'error').length,
    duplicates: rows.filter((r) => r.status === 'duplicate').length,
  });
});

router.post('/import/confirm', (req, res) => {
  const rows = req.session.importRows || [];
  delete req.session.importRows;
  if (!rows.length) {
    req.flash('error', 'Nothing to import. Upload the file again.');
    return res.redirect('/import');
  }
  const valid = new Set(getSections().map((s) => s.id));
  const insert = db.prepare(`
    INSERT INTO students (name, parent_name, phone, section_id, join_date, billing_start)
    VALUES (@name, @parent_name, @phone, @section_id, @join_date, @billing_start)
  `);
  const enroll = db.prepare('INSERT INTO enrollments (student_id, section_id, from_month) VALUES (?, ?, ?)');
  let added = 0;
  db.transaction(() => {
    for (const r of rows) {
      if (!valid.has(r.section_id)) continue;
      const billing = billingStartFor(r.join_date);
      const id = insert.run({ ...r, billing_start: billing }).lastInsertRowid;
      enroll.run(id, r.section_id, billing);
      added += 1;
    }
  })();
  track(req.user, 'students_imported', { count: added });
  req.flash('success', `${added} student${added === 1 ? '' : 's'} imported.`);
  res.redirect('/students');
});

module.exports = router;

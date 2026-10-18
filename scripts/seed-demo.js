// Fills an EMPTY database with demo students, payments and attendance so you
// can try the app. Never run this on your real data:
//   DATA_DIR=./demo-data node scripts/seed-demo.js
process.env.TZ = process.env.TZ || 'Asia/Kolkata';
const { db, getSections } = require('../db');
const { allocate } = require('../lib/ledger');
const { today, currentMonth, addMonths } = require('../lib/dates');

if (db.prepare('SELECT COUNT(*) AS n FROM students').get().n > 0) {
  console.log('Database already has students; refusing to add demo data.');
  process.exit(1);
}

const FIRST = ['Aarav', 'Diya', 'Arjun', 'Ananya', 'Rahul', 'Fathima', 'Nihal', 'Sneha', 'Adwaith', 'Meera', 'Rohan',
  'Aisha', 'Kiran', 'Nandana', 'Vishnu', 'Riya', 'Abhinav', 'Gowri', 'Sidharth', 'Hiba', 'Joel', 'Anjali', 'Farhan', 'Devika'];
const LAST = ['Nair', 'Menon', 'Pillai', 'Kumar', 'Thomas', 'Joseph', 'Rahman', 'Varghese', 'Krishnan', 'Das', 'Mathew', 'Ali'];
const PARENT = ['Suresh', 'Lakshmi', 'Abdul', 'Mary', 'Rajesh', 'Shameena', 'George', 'Bindu', 'Prakash', 'Sajitha'];

let seed = 7;
const rand = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
const pick = (arr) => arr[Math.floor(rand() * arr.length)];

const yearStart = addMonths(currentMonth(), -4);
const adminId = db.prepare("SELECT id FROM users WHERE role = 'admin' ORDER BY id LIMIT 1").get()?.id || null;

const insertStudent = db.prepare(`
  INSERT INTO students (name, parent_name, phone, section_id, join_date, billing_start)
  VALUES (?, ?, ?, ?, ?, ?)
`);
const insertEnroll = db.prepare('INSERT INTO enrollments (student_id, section_id, from_month) VALUES (?, ?, ?)');
const insertPayment = db.prepare(`
  INSERT INTO payments (receipt_no, student_id, amount, method, paid_on, collected_by) VALUES (?, ?, ?, ?, ?, ?)
`);
const insertPart = db.prepare('INSERT INTO payment_months (payment_id, month, amount) VALUES (?, ?, ?)');
const insertAtt = db.prepare('INSERT OR IGNORE INTO attendance (student_id, date, section_id, status, marked_by) VALUES (?, ?, ?, ?, ?)');

let receiptSeq = 0;
db.transaction(() => {
  for (const section of getSections()) {
    const count = 10 + Math.floor(rand() * 6);
    for (let i = 0; i < count; i++) {
      const name = `${pick(FIRST)} ${pick(LAST)}`;
      const phone = `9${Math.floor(100000000 + rand() * 899999999)}`;
      const id = insertStudent.run(name, `${pick(PARENT)} ${name.split(' ')[1]}`, phone, section.id, `${yearStart}-01`, yearStart).lastInsertRowid;
      insertEnroll.run(id, section.id, yearStart);

      // Most students pay on time; some fall behind by 1–3 months.
      const behind = rand() < 0.65 ? 0 : 1 + Math.floor(rand() * 3);
      const monthsToPay = 5 - behind;
      for (let m = 0; m < monthsToPay; m++) {
        const month = addMonths(yearStart, m);
        const day = String(3 + Math.floor(rand() * 10)).padStart(2, '0');
        let paidOn = `${month}-${day}`;
        if (paidOn > today()) paidOn = today();
        const parts = allocate(id, 2500);
        receiptSeq += 1;
        const pid = insertPayment.run(`R-${paidOn.slice(0, 4)}-${String(receiptSeq).padStart(4, '0')}`, id, 2500,
          rand() < 0.55 ? 'UPI' : 'Cash', paidOn, adminId).lastInsertRowid;
        for (const p of parts) insertPart.run(pid, p.month, p.amount);
      }
    }
  }

  // Attendance for the last 14 days, skipping Sundays.
  const students = db.prepare('SELECT id, section_id FROM students').all();
  for (let back = 14; back >= 1; back--) {
    const d = new Date();
    d.setDate(d.getDate() - back);
    if (d.getDay() === 0) continue;
    const date = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    for (const s of students) insertAtt.run(s.id, date, s.section_id, rand() < 0.9 ? 'P' : 'A', adminId);
  }
})();

console.log(`Demo data added: ${db.prepare('SELECT COUNT(*) AS n FROM students').get().n} students, ${receiptSeq} payments.`);

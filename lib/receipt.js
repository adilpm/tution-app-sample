const PDFDocument = require('pdfkit');
const { number, amountInWords } = require('./format');
const { monthLabel, dateLabel } = require('./dates');

// The built-in PDF fonts have no ₹ glyph, so receipts use "Rs.".
const rs = (n) => `Rs. ${number(n)}`;

const BRAND = '#1f4e79';
const MUTED = '#5f6b7a';
const LINE = '#d5dbe3';

/**
 * Streams an A5 receipt to `out` (an HTTP response or any writable stream).
 * data = { payment, student, sectionLabel, months: [{month, amount}], settings, collectedBy }
 */
function writeReceipt(out, { payment, student, sectionLabel, months, settings, collectedBy }) {
  const doc = new PDFDocument({
    size: 'A5',
    margin: 32,
    info: { Title: `Receipt ${payment.receipt_no}`, Author: settings.center_name },
  });
  doc.pipe(out);

  const left = 32;
  const width = doc.page.width - 64;
  const right = left + width;

  // Header band
  doc.rect(0, 0, doc.page.width, 84).fill(BRAND);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(17)
    .text(settings.center_name || '', left, 20, { width, align: 'center' });
  doc.font('Helvetica').fontSize(8.5)
    .text(settings.center_address || '', left, doc.y + 4, { width, align: 'center' })
    .text(settings.center_phone ? `Phone: ${settings.center_phone}` : '', { width, align: 'center' });

  // Title and receipt meta
  let y = 102;
  doc.fillColor('#111111').font('Helvetica-Bold').fontSize(12)
    .text('FEE RECEIPT', left, y, { width, align: 'center', characterSpacing: 1.5 });
  y += 26;
  doc.font('Helvetica').fontSize(9).fillColor(MUTED);
  doc.text('Receipt No.', left, y);
  doc.text('Date', left, y, { width, align: 'right' });
  doc.font('Helvetica-Bold').fontSize(10.5).fillColor('#111111');
  doc.text(payment.receipt_no, left, y + 12);
  doc.text(dateLabel(payment.paid_on), left, y + 12, { width, align: 'right' });
  y += 34;
  doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).lineWidth(1).stroke();

  // Student details
  y += 12;
  const rows = [
    ['Student', student.name],
    ['Parent / Guardian', student.parent_name || '-'],
    ['Class', sectionLabel],
    ['Payment mode', payment.method],
  ];
  if (payment.note) rows.push(['Note', payment.note]);
  for (const [label, value] of rows) {
    doc.font('Helvetica').fontSize(9).fillColor(MUTED).text(label, left, y, { width: 110 });
    doc.font('Helvetica-Bold').fontSize(10).fillColor('#111111').text(value, left + 115, y, { width: width - 115 });
    y = Math.max(doc.y, y + 12) + 6;
  }

  // Months table
  y += 6;
  doc.rect(left, y, width, 20).fill('#eef2f7');
  doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(8.5);
  doc.text('FEE MONTH', left + 10, y + 6);
  doc.text('AMOUNT', left, y + 6, { width: width - 10, align: 'right' });
  y += 20;
  doc.font('Helvetica').fontSize(10).fillColor('#111111');
  for (const m of months) {
    doc.text(monthLabel(m.month), left + 10, y + 6);
    doc.text(rs(m.amount), left, y + 6, { width: width - 10, align: 'right' });
    y += 20;
    doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).lineWidth(0.5).stroke();
  }

  // Total
  y += 8;
  doc.rect(left, y, width, 30).fill(BRAND);
  doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(11).text('TOTAL PAID', left + 10, y + 10);
  doc.fontSize(13).text(rs(payment.amount), left, y + 9, { width: width - 10, align: 'right' });
  y += 38;
  doc.fillColor(MUTED).font('Helvetica-Oblique').fontSize(9)
    .text(amountInWords(payment.amount), left, y, { width });

  // Footer sits inside the bottom margin; without this PDFKit starts page 2.
  doc.page.margins.bottom = 0;
  const footerY = doc.page.height - 70;
  doc.font('Helvetica').fontSize(9).fillColor(MUTED)
    .text(`Collected by: ${collectedBy || '-'}`, left, footerY);
  doc.moveTo(right - 120, footerY + 8).lineTo(right, footerY + 8).strokeColor('#999999').lineWidth(0.5).stroke();
  doc.text('Signature', right - 120, footerY + 12, { width: 120, align: 'center' });
  doc.fontSize(7.5).text('This is a computer-generated receipt.', left, doc.page.height - 40, { width, align: 'center' });

  if (payment.voided) {
    doc.save();
    doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
    doc.fillColor('#c0392b').opacity(0.25).font('Helvetica-Bold').fontSize(90)
      .text('VOID', 0, doc.page.height / 2 - 50, { width: doc.page.width, align: 'center' });
    doc.restore();
  }

  doc.end();
}

module.exports = { writeReceipt };

const PDFDocument = require('pdfkit');
const { amountInWords } = require('./format');
const { dateLabel } = require('./dates');
const { registerFonts, rupees, logoPath } = require('./pdf-kit');

const BRAND = '#1d1d1f';
const ACCENT = '#0071e3';
const MUTED = '#6e6e73';
const LINE = '#d2d2d7';

/**
 * Streams an A5 receipt to `out` (an HTTP response or any writable stream).
 * data = { payment, student, sectionLabel, lines: [{label, amount}], settings, collectedBy }
 */
function writeReceipt(out, { payment, student, sectionLabel, lines, settings, collectedBy }) {
  const doc = new PDFDocument({
    size: 'A5',
    margin: 32,
    info: { Title: `Receipt ${payment.receipt_no}`, Author: settings.center_name },
  });
  registerFonts(doc);
  doc.pipe(out);

  const left = 32;
  const width = doc.page.width - 64;
  const right = left + width;

  // Header: optional logo, then center details
  let y = 28;
  const logo = logoPath();
  if (logo) {
    try {
      doc.image(logo, doc.page.width / 2 - 24, y, { fit: [48, 48], align: 'center' });
      y += 54;
    } catch {
      // Unreadable image: skip it rather than fail the receipt.
    }
  }
  doc.fillColor(BRAND).font('Bold').fontSize(16)
    .text(settings.center_name || '', left, y, { width, align: 'center' });
  doc.font('Body').fontSize(8.5).fillColor(MUTED)
    .text(settings.center_address || '', left, doc.y + 2, { width, align: 'center' })
    .text(settings.center_phone ? `Phone: ${settings.center_phone}` : '', { width, align: 'center' });
  y = doc.y + 10;
  doc.moveTo(left, y).lineTo(right, y).strokeColor(LINE).lineWidth(1).stroke();

  // Title and receipt meta
  y += 14;
  doc.fillColor(ACCENT).font('Bold').fontSize(11)
    .text('FEE RECEIPT', left, y, { width, align: 'center', characterSpacing: 2 });
  y += 26;
  doc.font('Body').fontSize(8.5).fillColor(MUTED);
  doc.text('Receipt No.', left, y);
  doc.text('Date', left, y, { width, align: 'right' });
  doc.font('Bold').fontSize(10.5).fillColor(BRAND);
  doc.text(payment.receipt_no, left, y + 12);
  doc.text(dateLabel(payment.paid_on), left, y + 12, { width, align: 'right' });
  y += 36;

  // Student details
  const rows = [
    ['Student', student.name],
    ['Parent / Guardian', student.parent_name || '-'],
    ['Class', sectionLabel],
    ['Payment mode', payment.method],
  ];
  if (payment.note) rows.push(['Note', payment.note]);
  for (const [label, value] of rows) {
    doc.font('Body').fontSize(8.5).fillColor(MUTED).text(label, left, y, { width: 110 });
    doc.font('Bold').fontSize(9.5).fillColor(BRAND).text(value, left + 115, y, { width: width - 115 });
    y = Math.max(doc.y, y + 12) + 6;
  }

  // Items table
  y += 6;
  doc.roundedRect(left, y, width, 22, 6).fill('#f5f5f7');
  doc.fillColor(MUTED).font('Bold').fontSize(7.5);
  doc.text('DESCRIPTION', left + 10, y + 7);
  doc.text('AMOUNT', left, y + 7, { width: width - 10, align: 'right' });
  y += 22;
  doc.font('Body').fontSize(9.5).fillColor(BRAND);
  for (const line of lines) {
    doc.text(line.label, left + 10, y + 6, { width: width - 110 });
    doc.text(rupees(line.amount), left, y + 6, { width: width - 10, align: 'right' });
    y += 22;
    doc.moveTo(left + 10, y).lineTo(right - 10, y).strokeColor(LINE).lineWidth(0.5).stroke();
  }

  // Total
  y += 10;
  doc.roundedRect(left, y, width, 34, 8).fill(BRAND);
  doc.fillColor('#ffffff').font('Bold').fontSize(10).text('TOTAL PAID', left + 12, y + 12);
  doc.fontSize(14).text(rupees(payment.amount), left, y + 9, { width: width - 12, align: 'right' });
  y += 42;
  doc.fillColor(MUTED).font('Italic').fontSize(8.5)
    .text(amountInWords(payment.amount), left, y, { width });

  // Footer sits inside the bottom margin; without this PDFKit starts page 2.
  doc.page.margins.bottom = 0;
  const footerY = doc.page.height - 70;
  doc.font('Body').fontSize(8.5).fillColor(MUTED)
    .text(`Collected by: ${collectedBy || '-'}`, left, footerY);
  doc.moveTo(right - 120, footerY + 8).lineTo(right, footerY + 8).strokeColor('#999999').lineWidth(0.5).stroke();
  doc.text('Signature', right - 120, footerY + 12, { width: 120, align: 'center' });
  doc.fontSize(7).text('This is a computer-generated receipt.', left, doc.page.height - 40, { width, align: 'center' });

  if (payment.voided) {
    doc.save();
    doc.rotate(-30, { origin: [doc.page.width / 2, doc.page.height / 2] });
    doc.fillColor('#d70015').opacity(0.22).font('Bold').fontSize(90)
      .text('VOID', 0, doc.page.height / 2 - 50, { width: doc.page.width, align: 'center' });
    doc.restore();
  }

  doc.end();
}

module.exports = { writeReceipt };

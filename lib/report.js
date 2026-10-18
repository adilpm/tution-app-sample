// Payments report exports (PDF and Excel). Both take the same rows as the
// Payments page: voided receipts are listed but left out of the totals.

const PDFDocument = require('pdfkit');
const ExcelJS = require('exceljs');
const { number } = require('./format');
const { dateLabel, today } = require('./dates');

const rs = (n) => `Rs. ${number(n)}`;
const BRAND = '#1f4e79';
const MUTED = '#5f6b7a';
const LINE = '#d5dbe3';

function writePaymentsPdf(out, { payments, totals, periodLabel, settings }) {
  const doc = new PDFDocument({
    size: 'A4',
    margin: 36,
    bufferPages: true,
    info: { Title: `Payments report ${periodLabel}`, Author: settings.center_name },
  });
  doc.pipe(out);

  const left = 36;
  const width = doc.page.width - 72;
  const cols = [
    { key: 'date', title: 'DATE', w: 60 },
    { key: 'receipt', title: 'RECEIPT', w: 72 },
    { key: 'student', title: 'STUDENT', w: 120 },
    { key: 'class', title: 'CLASS', w: 42 },
    { key: 'months', title: 'FEE MONTHS', w: 112 },
    { key: 'method', title: 'MODE', w: 40 },
    { key: 'amount', title: 'AMOUNT', w: width - 446, align: 'right' },
  ];

  // Title block
  doc.fillColor('#111111').font('Helvetica-Bold').fontSize(16).text(settings.center_name || '', left, 36, { width });
  doc.font('Helvetica').fontSize(10).fillColor(MUTED)
    .text(`Payments report · ${periodLabel}`, { width })
    .text(`Generated on ${dateLabel(today())}`, { width });

  // Summary boxes
  let y = doc.y + 12;
  const boxes = [
    ['TOTAL COLLECTED', rs(totals.all)],
    ['CASH', rs(totals.cash)],
    ['UPI', rs(totals.upi)],
    ['RECEIPTS', String(totals.count)],
  ];
  const gap = 8;
  const boxW = (width - gap * 3) / 4;
  boxes.forEach(([label, value], i) => {
    const x = left + i * (boxW + gap);
    doc.roundedRect(x, y, boxW, 46, 6).fill(i === 0 ? BRAND : '#eef2f7');
    doc.fillColor(i === 0 ? '#ffffff' : MUTED).font('Helvetica-Bold').fontSize(7.5).text(label, x + 10, y + 9, { width: boxW - 20 });
    doc.fillColor(i === 0 ? '#ffffff' : '#111111').fontSize(13).text(value, x + 10, y + 22, { width: boxW - 20 });
  });
  y += 62;

  const drawHeader = () => {
    doc.rect(left, y, width, 20).fill('#eef2f7');
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(7.5);
    let x = left;
    for (const c of cols) {
      doc.text(c.title, x + 5, y + 7, { width: c.w - 10, align: c.align || 'left', lineBreak: false });
      x += c.w;
    }
    y += 20;
  };
  drawHeader();

  if (!payments.length) {
    doc.fillColor(MUTED).font('Helvetica').fontSize(10).text(`No payments for ${periodLabel}.`, left, y + 14, { width, align: 'center' });
  }

  const ROW_H = 18;
  for (const p of payments) {
    if (y + ROW_H > doc.page.height - 56) {
      doc.addPage();
      y = 36;
      drawHeader();
    }
    const cells = {
      date: dateLabel(p.paid_on),
      receipt: p.receipt_no,
      student: p.student_name,
      class: p.label || '',
      months: p.monthsText,
      method: p.method,
      amount: p.voided ? `VOID ${rs(p.amount)}` : rs(p.amount),
    };
    doc.font('Helvetica').fontSize(8.5).fillColor(p.voided ? '#b42318' : '#111111');
    let x = left;
    for (const c of cols) {
      doc.text(cells[c.key], x + 5, y + 5, {
        width: c.w - 10, height: 10, align: c.align || 'left', lineBreak: false, ellipsis: true,
      });
      x += c.w;
    }
    y += ROW_H;
    doc.moveTo(left, y).lineTo(left + width, y).strokeColor(LINE).lineWidth(0.5).stroke();
  }

  if (payments.length) {
    if (y + 26 > doc.page.height - 56) {
      doc.addPage();
      y = 36;
    }
    y += 6;
    doc.rect(left, y, width, 22).fill(BRAND);
    doc.fillColor('#ffffff').font('Helvetica-Bold').fontSize(10)
      .text(`TOTAL (${totals.count} receipts, excluding void)`, left + 8, y + 7, { lineBreak: false })
      .text(rs(totals.all), left, y + 7, { width: width - 5, align: 'right', lineBreak: false });
  }

  // Page numbers; the footer sits inside the bottom margin.
  const range = doc.bufferedPageRange();
  for (let i = 0; i < range.count; i++) {
    doc.switchToPage(range.start + i);
    doc.page.margins.bottom = 0;
    doc.fillColor(MUTED).font('Helvetica').fontSize(8)
      .text(`Page ${i + 1} of ${range.count}`, left, doc.page.height - 30, { width, align: 'center', lineBreak: false });
  }
  doc.end();
}

async function writePaymentsXlsx(out, { payments, totals, periodLabel, settings }) {
  const wb = new ExcelJS.Workbook();
  wb.creator = settings.center_name || '';
  wb.created = new Date();
  const ws = wb.addWorksheet('Payments', { views: [{ state: 'frozen', ySplit: 4 }] });

  const headers = ['Receipt No', 'Date', 'Student', 'Class', 'Fee months', 'Method', 'Amount', 'Collected by', 'Note', 'Status', 'Void reason'];
  const widths = [14, 13, 26, 8, 26, 9, 12, 16, 24, 9, 24];
  widths.forEach((w, i) => { ws.getColumn(i + 1).width = w; });

  ws.getCell('A1').value = `${settings.center_name || ''} — Payments report`;
  ws.getCell('A1').font = { bold: true, size: 14 };
  ws.getCell('A2').value = `Period: ${periodLabel}`;
  ws.getCell('A2').font = { color: { argb: 'FF5F6B7A' } };

  const headerRow = ws.getRow(4);
  headerRow.values = headers;
  headerRow.font = { bold: true, color: { argb: 'FFFFFFFF' } };
  headerRow.eachCell((cell) => {
    cell.fill = { type: 'pattern', pattern: 'solid', fgColor: { argb: 'FF1F4E79' } };
  });

  for (const p of [...payments].reverse()) {
    const row = ws.addRow([
      p.receipt_no,
      new Date(`${p.paid_on}T00:00:00Z`),
      p.student_name,
      p.label,
      p.monthsText,
      p.method,
      p.amount,
      p.collected_by_name || '',
      p.note || '',
      p.voided ? 'VOID' : 'OK',
      p.void_reason || '',
    ]);
    row.getCell(2).numFmt = 'dd-mmm-yyyy';
    row.getCell(7).numFmt = '#,##0';
    if (p.voided) row.font = { strike: true, color: { argb: 'FFB42318' } };
  }
  ws.autoFilter = { from: { row: 4, column: 1 }, to: { row: 4, column: headers.length } };

  ws.addRow([]);
  const summary = [
    ['Total collected (excluding void)', totals.all],
    ['Cash', totals.cash],
    ['UPI', totals.upi],
    ['Receipts', totals.count],
  ];
  for (const [label, value] of summary) {
    const row = ws.addRow([label, null, null, null, null, null, value]);
    row.font = { bold: true };
    row.getCell(7).numFmt = '#,##0';
  }

  await wb.xlsx.write(out);
}

module.exports = { writePaymentsPdf, writePaymentsXlsx };

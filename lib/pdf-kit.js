// Shared PDF helpers: embedded DejaVu fonts (the built-in PDF fonts have no
// ₹ glyph) and the center's optional logo.
const path = require('path');
const fs = require('fs');
const { dataDir } = require('../db');
const { number } = require('./format');

const FONT_DIR = path.join(path.dirname(require.resolve('dejavu-fonts-ttf/package.json')), 'ttf');

function registerFonts(doc) {
  doc.registerFont('Body', path.join(FONT_DIR, 'DejaVuSans.ttf'));
  doc.registerFont('Bold', path.join(FONT_DIR, 'DejaVuSans-Bold.ttf'));
  doc.registerFont('Italic', path.join(FONT_DIR, 'DejaVuSans-Oblique.ttf'));
  doc.registerFont('Condensed', path.join(FONT_DIR, 'DejaVuSansCondensed.ttf'));
  doc.font('Body');
}

const rupees = (n) => `₹${number(n)}`;

// The uploaded logo, if any (PNG or JPEG, which is all PDFKit can embed).
function logoPath() {
  for (const ext of ['png', 'jpg']) {
    const file = path.join(dataDir, `logo.${ext}`);
    if (fs.existsSync(file)) return file;
  }
  return null;
}

module.exports = { registerFonts, rupees, logoPath };

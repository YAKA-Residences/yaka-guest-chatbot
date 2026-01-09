// generate-qr.js
const QRCode = require('qrcode');
const fs = require('fs-extra');
const path = require('path');
const { parse } = require('csv-parse/sync');   // <-- FIXED HERE

// CONFIG: change baseUrl to your hosted chat site
const baseUrl = 'https://ask.yakaresidences.com/?apt=';

// Output folder
const outDir = path.join(__dirname, 'out');
fs.ensureDirSync(outDir);

// Example apartments fallback
const apartments = ['YAKA01', 'YAKA02', 'YAKA03'];

// If CSV exists, read it
const csvPath = path.join(__dirname, 'apartments.csv');
let aptList = apartments;

if (fs.existsSync(csvPath)) {
  const raw = fs.readFileSync(csvPath, 'utf8');
  const rows = parse(raw, { columns: true, skip_empty_lines: true });

  aptList = rows.map(r => r.apt_id || Object.values(r)[0]).filter(Boolean);
}

(async () => {
  for (const apt of aptList) {
    const url = `${baseUrl}${encodeURIComponent(apt)}`;
    const outFile = path.join(outDir, `${apt}.png`);

    try {
      await QRCode.toFile(outFile, url, {
        errorCorrectionLevel: 'H',
        type: 'png',
        width: 1024,
        margin: 2
      });

      console.log('Generated:', outFile);
    } catch (err) {
      console.error('Failed for', apt, err);
    }
  }

  console.log('\n✔ Done! PNG QR codes are in the "out" folder.');
})();

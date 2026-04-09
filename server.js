const express = require('express');
const fs = require('fs');
const path = require('path');

const app = express();
const PORT = process.env.PORT || 3000;

// On Azure Linux App Service, /home is persistent storage
// Locally, use the project directory
const DATA_DIR = process.env.WEBSITE_SITE_NAME ? '/home/data' : __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Data helpers ─────────────────────────────────────────────
function readData() {
  try {
    if (fs.existsSync(DATA_FILE)) {
      return JSON.parse(fs.readFileSync(DATA_FILE, 'utf8'));
    }
  } catch (e) {
    console.error('Klaida skaitant duomenis:', e.message);
  }
  return {};
}

function writeData(data) {
  try {
    fs.writeFileSync(DATA_FILE, JSON.stringify(data, null, 2), 'utf8');
  } catch (e) {
    console.error('Klaida rašant duomenis:', e.message);
  }
}

// ── API endpoints ────────────────────────────────────────────

// Get a value by key
app.get('/api/store/:key', (req, res) => {
  const data = readData();
  const key = req.params.key;
  if (data.hasOwnProperty(key)) {
    res.json({ key, value: data[key] });
  } else {
    res.json({ key, value: null });
  }
});

// Set a value by key
app.put('/api/store/:key', (req, res) => {
  const data = readData();
  const key = req.params.key;
  data[key] = req.body.value;
  writeData(data);
  res.json({ ok: true });
});

// Fallback — serve index.html for any non-API route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start server ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  📐 Geopoint veikia: http://localhost:${PORT}\n`);

  // Ensure data directory exists
  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log('  📁 Sukurtas duomenų aplankas:', DATA_DIR);
  }

  // Initialize data file if it doesn't exist
  if (!fs.existsSync(DATA_FILE)) {
    writeData({});
    console.log('  ✅ Sukurtas naujas duomenų failas:', DATA_FILE);
  } else {
    console.log('  📄 Duomenų failas:', DATA_FILE);
  }
});

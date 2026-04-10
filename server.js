const express = require('express');
const fs = require('fs');
const path = require('path');
const ldap = require('ldapjs');

const app = express();
const PORT = process.env.PORT || 3000;

// On Azure Linux App Service, /home is persistent storage
// Locally, use the project directory
const DATA_DIR = process.env.WEBSITE_SITE_NAME ? '/home/data' : __dirname;
const DATA_FILE = path.join(DATA_DIR, 'data.json');

// ── Active Directory config ───────────────────────────────────
const LDAP_URL        = 'ldap://192.168.1.100:389';
const LDAP_BASE_DN    = 'DC=hata,DC=local';
const LDAP_SVC_DN     = process.env.LDAP_SVC_DN   || 'CN=svc_jira,OU=Service Accounts,DC=hata,DC=local';
const LDAP_SVC_PASS   = process.env.LDAP_SVC_PASS || '';

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

// ── AD / LDAP authentication ─────────────────────────────────
app.post('/api/auth/ldap', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Trūksta prisijungimo duomenų' });
  }

  const client = ldap.createClient({ url: LDAP_URL, timeout: 5000, connectTimeout: 5000 });

  let responded = false;
  function safeRespond(code, body) {
    if (!responded) { responded = true; res.status(code).json(body); }
  }

  client.on('error', (err) => {
    console.error('LDAP klaida:', err.message);
    safeRespond(503, { error: 'Nepavyko prisijungti prie Active Directory.' });
  });

  // Step 1: Bind with service account to search the directory
  client.bind(LDAP_SVC_DN, LDAP_SVC_PASS, (svcErr) => {
    if (svcErr) {
      client.destroy();
      console.error('LDAP service account bind nepavyko:', svcErr.message);
      return safeRespond(503, { error: 'AD konfigūracijos klaida. Kreipkitės į administratorių.' });
    }

    // Step 2: Find user's full DN by sAMAccountName
    const searchOpts = {
      filter: `(sAMAccountName=${username})`,
      scope: 'sub',
      attributes: ['dn', 'givenName', 'sn', 'mail', 'sAMAccountName'],
      timeLimit: 5,
    };

    client.search(LDAP_BASE_DN, searchOpts, (searchErr, result) => {
      if (searchErr) {
        client.destroy();
        return safeRespond(503, { error: 'AD paieškos klaida.' });
      }

      let userEntry = null;
      result.on('searchEntry', (entry) => { userEntry = entry; });
      result.on('error', () => { client.destroy(); safeRespond(503, { error: 'AD paieškos klaida.' }); });
      result.on('end', () => {
        if (!userEntry) {
          client.destroy();
          return safeRespond(401, { error: 'Vartotojas nerastas Active Directory.' });
        }

        const userDN  = userEntry.dn.toString();
        const attrs   = userEntry.object;
        const email   = attrs.mail || `${username}@hata.local`;
        const name    = [attrs.givenName, attrs.sn].filter(Boolean).join(' ') || username;

        // Step 3: Re-bind with user's own DN + their password to verify credentials
        client.bind(userDN, password, (userBindErr) => {
          client.unbind();
          if (userBindErr) {
            console.log('Neteisingas slaptažodis:', username);
            return safeRespond(401, { error: 'Neteisingas slaptažodis.' });
          }
          // Authentication successful
          finishLogin(res, username, email, name);
        });
      });
    });
  });
});

// Create or fetch user after successful AD auth
function finishLogin(res, username, email, displayName) {
  const data = readData();
  let users = data['gp-users'] || [];

  // Find existing user by AD username or email
  let user = users.find((u) => u.username === username || u.email === email);

  if (!user) {
    // New user — create with pending role, admin must assign
    user = {
      id: Date.now().toString(36) + Math.random().toString(36).slice(2, 5),
      name: displayName,
      email: email,
      username: username,
      role: 'pending',
      adAuth: true,
      mustChangePassword: false,
      password: null,
      createdAt: new Date().toISOString(),
    };
    users = users.concat([user]);
    data['gp-users'] = users;
    writeData(data);
    console.log(`  👤 Naujas AD vartotojas: ${displayName} (${email})`);
  } else {
    // Update name/email from AD in case they changed
    user = Object.assign({}, user, { name: displayName, email: email });
    data['gp-users'] = users.map((u) => (u.username === username ? user : u));
    writeData(data);
  }

  res.json({ user });
}

// Fallback — serve index.html for any non-API route
app.get('*', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// ── Start server ─────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`\n  📐 Geopoint veikia: http://localhost:${PORT}\n`);
  console.log(`  🔐 AD autentikacija: ${LDAP_URL} (${LDAP_DOMAIN})\n`);

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

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
const LDAP_URL      = 'ldap://192.168.1.100:389';
const LDAP_BASE_DN  = 'DC=hata,DC=local';
const LDAP_SVC_DN   = process.env.LDAP_SVC_DN   || 'CN=svc_jira,OU=Service Accounts,DC=hata,DC=local';
const LDAP_SVC_PASS = process.env.LDAP_SVC_PASS || '';

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

app.get('/api/store/:key', (req, res) => {
  const data = readData();
  const key = req.params.key;
  res.json({ key, value: data.hasOwnProperty(key) ? data[key] : null });
});

app.put('/api/store/:key', (req, res) => {
  const data = readData();
  data[req.params.key] = req.body.value;
  writeData(data);
  res.json({ ok: true });
});

// ── AD / LDAP authentication ─────────────────────────────────
app.post('/api/auth/ldap', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password) {
    return res.status(400).json({ error: 'Trūksta prisijungimo duomenų' });
  }

  let responded = false;
  function safeRespond(code, body) {
    if (!responded) { responded = true; res.status(code).json(body); }
  }
  function makeClient() {
    return ldap.createClient({ url: LDAP_URL, timeout: 5000, connectTimeout: 5000, reconnect: false });
  }

  // Step 1: Verify password by binding directly with UPN (username@hata.local)
  console.log('[LDAP] Step 1: Verifying credentials for:', username);
  const authClient = makeClient();
  authClient.on('error', (err) => {
    console.error('[LDAP] Step 1 connection error:', err.message);
    safeRespond(503, { error: 'Nepavyko prisijungti prie Active Directory.' });
  });

  authClient.bind(`${username}@hata.local`, password, (bindErr) => {
    authClient.destroy();
    if (bindErr) {
      console.log('[LDAP] Step 1 FAILED:', bindErr.message);
      return safeRespond(401, { error: 'Neteisingas vartotojo vardas arba slaptažodis.' });
    }
    console.log('[LDAP] Step 1 OK - credentials verified');

    // Step 2: Fetch display name and email via service account
    console.log('[LDAP] Step 2: Fetching user details...');
    const svcClient = makeClient();
    svcClient.on('error', () => {
      finishLogin(res, username, `${username}@hata.local`, username);
    });

    svcClient.bind(LDAP_SVC_DN, LDAP_SVC_PASS, (svcErr) => {
      if (svcErr) {
        svcClient.destroy();
        console.log('[LDAP] Step 2 svc bind failed, using minimal info');
        return finishLogin(res, username, `${username}@hata.local`, username);
      }

      const searchOpts = {
        filter: `(&(objectCategory=Person)(sAMAccountName=${username}))`,
        scope: 'sub',
        attributes: ['givenName', 'sn', 'mail'],
        timeLimit: 5,
      };

      svcClient.search(LDAP_BASE_DN, searchOpts, (searchErr, result) => {
        if (searchErr) {
          svcClient.destroy();
          console.log('[LDAP] Step 2 search error:', searchErr.message);
          return finishLogin(res, username, `${username}@hata.local`, username);
        }

        let attrs = {};
        result.on('searchEntry', (entry) => {
          (entry.attributes || []).forEach((a) => {
            attrs[a.type] = a.values && a.values.length === 1 ? a.values[0] : a.values;
          });
          console.log('[LDAP] Step 2 attrs:', JSON.stringify(attrs));
        });
        result.on('searchReference', () => {});
        result.on('error', () => {
          svcClient.destroy();
          const email = attrs.mail || `${username}@hata.local`;
          const name  = [attrs.givenName, attrs.sn].filter(Boolean).join(' ') || username;
          finishLogin(res, username, email, name);
        });
        result.on('end', () => {
          svcClient.unbind();
          const email = attrs.mail || `${username}@hata.local`;
          const name  = [attrs.givenName, attrs.sn].filter(Boolean).join(' ') || username;
          console.log('[LDAP] Step 2 complete. Name:', name, '| Email:', email);
          finishLogin(res, username, email, name);
        });
      });
    });
  });
});

// Create or update user after successful AD auth
function finishLogin(res, username, email, displayName) {
  const data = readData();
  let users = data['gp-users'] || [];

  let user = users.find((u) => u.username === username || u.email === email);

  if (!user) {
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
  console.log(`  🔐 AD autentikacija: ${LDAP_URL}\n`);

  if (!fs.existsSync(DATA_DIR)) {
    fs.mkdirSync(DATA_DIR, { recursive: true });
    console.log('  📁 Sukurtas duomenų aplankas:', DATA_DIR);
  }
  if (!fs.existsSync(DATA_FILE)) {
    writeData({});
    console.log('  ✅ Sukurtas naujas duomenų failas:', DATA_FILE);
  } else {
    console.log('  📄 Duomenų failas:', DATA_FILE);
  }
});

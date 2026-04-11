const express = require('express');
const fs = require('fs');
const path = require('path');
const ldap = require('ldapjs');
const Database = require('better-sqlite3');

const app = express();
const PORT = process.env.PORT || 3000;

// On Azure Linux App Service, /home is persistent storage
// Locally, use the project directory
const DATA_DIR  = process.env.WEBSITE_SITE_NAME ? '/home/data' : __dirname;
const DB_FILE   = path.join(DATA_DIR, 'geopoint.db');
const JSON_FILE = path.join(DATA_DIR, 'data.json'); // legacy — migrated on first run

// ── Active Directory config ───────────────────────────────────
const LDAP_URL      = 'ldap://192.168.1.100:389';
const LDAP_BASE_DN  = 'DC=hata,DC=local';
const LDAP_SVC_DN   = process.env.LDAP_SVC_DN   || 'CN=svc_jira,OU=Service Accounts,DC=hata,DC=local';
const LDAP_SVC_PASS = process.env.LDAP_SVC_PASS || '';

// Middleware
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname, 'public')));

// ── Database setup ────────────────────────────────────────────
if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

const db = new Database(DB_FILE);
db.pragma('journal_mode = WAL'); // better concurrent read performance

// Single key-value table — keeps the same API surface as before
db.exec(`
  CREATE TABLE IF NOT EXISTS store (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  )
`);

// Migrate existing data.json → SQLite (runs once)
if (fs.existsSync(JSON_FILE)) {
  try {
    const legacy = JSON.parse(fs.readFileSync(JSON_FILE, 'utf8'));
    const insert = db.prepare('INSERT OR IGNORE INTO store (key, value) VALUES (?, ?)');
    const migrate = db.transaction((obj) => {
      for (const [k, v] of Object.entries(obj)) {
        insert.run(k, JSON.stringify(v));
      }
    });
    migrate(legacy);
    fs.renameSync(JSON_FILE, JSON_FILE + '.migrated');
    console.log('  ✅ data.json migrated to SQLite');
  } catch (e) {
    console.error('  ⚠️  Migration error:', e.message);
  }
}

// ── Data helpers ─────────────────────────────────────────────
const stmtGet    = db.prepare('SELECT value FROM store WHERE key = ?');
const stmtSet    = db.prepare('INSERT OR REPLACE INTO store (key, value) VALUES (?, ?)');
const stmtDelete = db.prepare('DELETE FROM store WHERE key = ?');

function dbGet(key) {
  const row = stmtGet.get(key);
  return row ? JSON.parse(row.value) : null;
}

function dbSet(key, value) {
  if (value === null || value === undefined) {
    stmtDelete.run(key);
  } else {
    stmtSet.run(key, JSON.stringify(value));
  }
}

// ── One-time DB cleanup: remove fake @hata.local emails stored by older code ─
(function fixFakeEmails() {
  const users = dbGet('gp-users');
  if (!Array.isArray(users)) return;
  let changed = false;
  const fixed = users.map((u) => {
    if (u.adAuth && u.email && u.email.endsWith('@hata.local')) {
      changed = true;
      console.log(`  🔧 Taisomas netikras el. paštas vartotojui: ${u.username}`);
      return Object.assign({}, u, { email: '' });
    }
    return u;
  });
  if (changed) dbSet('gp-users', fixed);
})();

// ── Startup: ensure geoadmin local admin exists and has a password ─
(function ensureLocalAdmin() {
  const users = dbGet('gp-users') || [];
  const hasGeoadmin = users.find((u) => !u.adAuth && u.username === 'geoadmin');

  if (hasGeoadmin) {
    // Geoadmin exists — make sure password wasn't wiped by the frontend save bug
    if (!hasGeoadmin.password) {
      const fixed = users.map((u) =>
        u.id === hasGeoadmin.id
          ? Object.assign({}, u, { password: 'Energo99', mustChangePassword: true })
          : u
      );
      dbSet('gp-users', fixed);
      console.log('  🔧 Atkurtas geoadmin slaptažodis (buvo ištryntas)');
    }
    return;
  }

  // No geoadmin yet — migrate old admin or create fresh
  const oldAdmin = users.find((u) => u.id === 'admin1' || (!u.adAuth && u.role === 'admin'));
  if (oldAdmin) {
    const pw = oldAdmin.password || 'Energo99';
    const migrated = users.map((u) =>
      u.id === oldAdmin.id
        ? Object.assign({}, u, { username: 'geoadmin', email: '', password: pw })
        : u
    );
    dbSet('gp-users', migrated);
    console.log('  🔧 Vietinis administratorius pervadintas į geoadmin');
  } else {
    dbSet('gp-users', users.concat([{
      id: 'admin1',
      name: 'Administratorius',
      username: 'geoadmin',
      email: '',
      password: 'Energo99',
      role: 'admin',
      adAuth: false,
      mustChangePassword: true,
      createdAt: new Date().toISOString(),
    }]));
    console.log('  👤 Sukurtas vietinis administratorius: geoadmin');
  }
})();

// ── API endpoints ────────────────────────────────────────────

// gp-users GET: strip passwords before sending to client
app.get('/api/store/gp-users', (req, res) => {
  const users = dbGet('gp-users') || [];
  res.json({ key: 'gp-users', value: users.map(({ password, ...u }) => u) });
});

// gp-users PUT: client never has passwords, so merge them back from DB before saving
app.put('/api/store/gp-users', (req, res) => {
  const incoming = Array.isArray(req.body.value) ? req.body.value : [];
  const existing = dbGet('gp-users') || [];
  const pwMap = {};
  existing.forEach((u) => { if (u.password) pwMap[u.id] = u.password; });

  const merged = incoming.map((u) => {
    // Restore password if client didn't send one (it was stripped)
    if (!u.password && pwMap[u.id]) return Object.assign({}, u, { password: pwMap[u.id] });
    return u;
  });
  dbSet('gp-users', merged);
  res.json({ ok: true });
});

app.get('/api/store/:key', (req, res) => {
  res.json({ key: req.params.key, value: dbGet(req.params.key) });
});

app.put('/api/store/:key', (req, res) => {
  dbSet(req.params.key, req.body.value);
  res.json({ ok: true });
});

// ── Local (non-AD) login ──────────────────────────────────────
app.post('/api/auth/local', (req, res) => {
  const { username, password } = req.body;
  if (!username || !password)
    return res.status(400).json({ error: 'Trūksta prisijungimo duomenų.' });

  const users = dbGet('gp-users') || [];
  const user  = users.find((u) => !u.adAuth && u.username === username);

  if (!user)            return res.status(401).json({ error: 'Vartotojas nerastas.' });
  if (user.password !== password) return res.status(401).json({ error: 'Neteisingas slaptažodis.' });

  const { password: _pw, ...safeUser } = user;
  res.json({ user: safeUser });
});

// ── Change password (local users only) ───────────────────────
app.post('/api/auth/change-password', (req, res) => {
  const { userId, oldPassword, newPassword, forceChange } = req.body;
  if (!userId || !newPassword)
    return res.status(400).json({ error: 'Trūksta duomenų.' });
  if (newPassword.length < 4)
    return res.status(400).json({ error: 'Slaptažodis per trumpas (min. 4 simboliai).' });

  const users = dbGet('gp-users') || [];
  const user  = users.find((u) => u.id === userId);

  if (!user) return res.status(404).json({ error: 'Vartotojas nerastas.' });
  if (user.adAuth) return res.status(400).json({ error: 'AD vartotojai slaptažodžio nekeičia čia.' });

  // Require old password unless: first forced login change, or admin-initiated reset
  const skipOldCheck = user.mustChangePassword || forceChange;
  if (!skipOldCheck && user.password !== oldPassword) {
    return res.status(401).json({ error: 'Neteisingas dabartinis slaptažodis.' });
  }

  const mustChange = forceChange ? true : false;
  const updated = Object.assign({}, user, { password: newPassword, mustChangePassword: mustChange });
  dbSet('gp-users', users.map((u) => (u.id === userId ? updated : u)));

  const { password: _pw, ...safeUser } = updated;
  res.json({ user: safeUser });
});

// ── AD / LDAP authentication ─────────────────────────────────
app.post('/api/auth/ldap', (req, res) => {
  // Strip domain suffix if user typed "user@domain" — we always build UPN ourselves
  const rawUsername = (req.body.username || '').trim();
  const username = rawUsername.replace(/@[^@]*$/, '');
  const { password } = req.body;
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
      finishLogin(res, username, '', username);
    });

    svcClient.bind(LDAP_SVC_DN, LDAP_SVC_PASS, (svcErr) => {
      if (svcErr) {
        svcClient.destroy();
        console.log('[LDAP] Step 2 svc bind failed, using minimal info');
        return finishLogin(res, username, '', username);
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
          return finishLogin(res, username, '', username);
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
          const email = attrs.mail || '';
          const name  = [attrs.givenName, attrs.sn].filter(Boolean).join(' ') || username;
          finishLogin(res, username, email, name);
        });
        result.on('end', () => {
          svcClient.unbind();
          const email = attrs.mail || '';
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
  let users = dbGet('gp-users') || [];

  // Only match by username (exact) or by email when email is non-empty.
  // Never match on empty email — it would collide with any user missing an email field.
  const existingByUsername = users.find((u) => u.adAuth && u.username === username);
  const existingByEmail    = email ? users.find((u) => u.adAuth && u.email === email) : null;
  let user = existingByUsername || existingByEmail || null;

  if (!user) {
    // Brand-new AD user — always starts as 'pending', no role
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
    dbSet('gp-users', users.concat([user]));
    console.log(`  👤 Naujas AD vartotojas: ${displayName} (${email || username})`);
  } else {
    // Returning user — refresh name/email from AD but keep their assigned role intact
    const updatedEmail = email || user.email; // never overwrite real email with empty string
    user = Object.assign({}, user, { name: displayName, email: updatedEmail, username: username });
    dbSet('gp-users', users.map((u) => (u.id === user.id ? user : u)));
    console.log(`  🔄 AD vartotojas prisijungė: ${displayName} (${updatedEmail || username}), rolė: ${user.role}`);
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

  console.log(`  🗄️  Duomenų bazė: ${DB_FILE}`);
});

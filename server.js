const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const nodemailer = require('nodemailer');

loadEnv(path.join(__dirname, '.env'));

const PORT = Number(process.env.PORT || 3000);
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'change-this-password';
const publicDir = path.join(__dirname, 'public');
const dataDir = path.join(__dirname, 'data');
const settingsFile = path.join(dataDir, 'settings.json');
const requestsFile = path.join(dataDir, 'requests.json');
const sessions = new Set();
const MAX_MANAGER_EMAILS = 5;

fs.mkdirSync(dataDir, { recursive: true });

function loadEnv(file) {
  if (!fs.existsSync(file)) return;
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Z0-9_]+)\s*=\s*(.*)\s*$/i);
    if (match && !process.env[match[1]]) process.env[match[1]] = match[2].replace(/^['"]|['"]$/g, '');
  }
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function writeJson(file, value) {
  fs.writeFileSync(file, JSON.stringify(value, null, 2));
}

function getSettings() {
  return readJson(settingsFile, {
    managerEmails: ['', '', '', '', ''], smtpHost: '', smtpPort: 587, smtpSecure: false, smtpUser: '', smtpPassword: '', fromName: 'Factory SOS'
  });
}

function normaliseManagerEmails(value) {
  const entries = Array.isArray(value) ? value : [value || ''];
  const unique = new Set();
  for (const entry of entries) {
    const email = String(entry || '').trim().toLowerCase();
    if (!email) continue;
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) throw new Error(`Invalid manager email address: ${email}`);
    unique.add(email);
  }
  return [...unique].slice(0, MAX_MANAGER_EMAILS);
}

function safeSettings(settings) {
  const copy = { ...settings };
  if (!Array.isArray(copy.managerEmails)) copy.managerEmails = [copy.managerEmail || ''];
  copy.managerEmails = [...copy.managerEmails.slice(0, MAX_MANAGER_EMAILS), ...Array(MAX_MANAGER_EMAILS).fill('')].slice(0, MAX_MANAGER_EMAILS);
  delete copy.managerEmail;
  delete copy.smtpPassword;
  copy.smtpPasswordConfigured = Boolean(settings.smtpPassword);
  return copy;
}

function send(res, status, body, type = 'application/json') {
  res.writeHead(status, { 'Content-Type': `${type}; charset=utf-8`, 'Cache-Control': 'no-store' });
  res.end(type === 'application/json' ? JSON.stringify(body) : body);
}

function parseBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';
    req.on('data', part => { raw += part; if (raw.length > 100000) req.destroy(); });
    req.on('end', () => { try { resolve(raw ? JSON.parse(raw) : {}); } catch { reject(new Error('Invalid JSON')); } });
    req.on('error', reject);
  });
}

function isAdmin(req) {
  const token = (req.headers.authorization || '').replace(/^Bearer\s+/i, '');
  return sessions.has(token);
}

async function sendSosEmail(request) {
  const settings = getSettings();
  const recipients = normaliseManagerEmails(Array.isArray(settings.managerEmails) ? settings.managerEmails : settings.managerEmail);
  if (!recipients.length || !settings.smtpHost || !settings.smtpUser || !settings.smtpPassword) {
    return { sent: false, reason: 'Email is not configured yet.' };
  }
  const transporter = nodemailer.createTransport({
    host: settings.smtpHost,
    port: Number(settings.smtpPort || 587),
    secure: Boolean(settings.smtpSecure),
    auth: { user: settings.smtpUser, pass: settings.smtpPassword }
  });
  const subject = `SOS: ${request.issue} — ${request.workerName || request.deviceName}`;
  const text = [
    'A worker needs assistance.', '',
    `Issue: ${request.issue}`,
    `Worker / device: ${request.workerName || 'Not provided'} / ${request.deviceName || 'Not provided'}`,
    `Location / line: ${request.location || 'Not provided'}`,
    `Note: ${request.note || 'None'}`,
    `Time: ${new Date(request.createdAt).toLocaleString()}`
  ].join('\n');
  await transporter.sendMail({ from: `"${settings.fromName || 'Factory SOS'}" <${settings.smtpUser}>`, to: recipients.join(', '), subject, text });
  return { sent: true };
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  try {
    if (req.method === 'POST' && url.pathname === '/api/sos') {
      const input = await parseBody(req);
      const request = {
        id: crypto.randomUUID(),
        issue: String(input.issue || 'Assistance requested').slice(0, 80),
        workerName: String(input.workerName || '').slice(0, 80),
        deviceName: String(input.deviceName || '').slice(0, 80),
        location: String(input.location || '').slice(0, 100),
        note: String(input.note || '').slice(0, 500),
        createdAt: new Date().toISOString()
      };
      const requests = readJson(requestsFile, []);
      requests.unshift(request);
      writeJson(requestsFile, requests.slice(0, 1000));
      let email = { sent: false };
      try { email = await sendSosEmail(request); } catch (error) { email = { sent: false, reason: error.message }; }
      return send(res, 201, { ok: true, email });
    }

    if (req.method === 'POST' && url.pathname === '/api/admin/login') {
      const { password } = await parseBody(req);
      if (password !== ADMIN_PASSWORD) return send(res, 401, { error: 'Incorrect password' });
      const token = crypto.randomBytes(32).toString('hex');
      sessions.add(token);
      return send(res, 200, { token });
    }

    if (url.pathname.startsWith('/api/admin/')) {
      if (!isAdmin(req)) return send(res, 401, { error: 'Sign in required' });
      if (req.method === 'GET' && url.pathname === '/api/admin/settings') return send(res, 200, safeSettings(getSettings()));
      if (req.method === 'PUT' && url.pathname === '/api/admin/settings') {
        const old = getSettings(); const input = await parseBody(req);
        const managerEmails = normaliseManagerEmails(input.managerEmails || input.managerEmail);
        if (!managerEmails.length) return send(res, 400, { error: 'Enter at least one manager notification email.' });
        const next = {
          managerEmails, smtpHost: String(input.smtpHost || '').trim(),
          smtpPort: Number(input.smtpPort || 587), smtpSecure: Boolean(input.smtpSecure), smtpUser: String(input.smtpUser || '').trim(),
          smtpPassword: input.smtpPassword ? String(input.smtpPassword) : old.smtpPassword, fromName: String(input.fromName || 'Factory SOS').trim()
        };
        writeJson(settingsFile, next); return send(res, 200, safeSettings(next));
      }
      if (req.method === 'GET' && url.pathname === '/api/admin/requests') return send(res, 200, readJson(requestsFile, []));
      return send(res, 404, { error: 'Not found' });
    }

    const requested = url.pathname === '/' ? '/index.html' : url.pathname;
    const file = path.normalize(path.join(publicDir, requested));
    if (!file.startsWith(publicDir) || !fs.existsSync(file) || fs.statSync(file).isDirectory()) return send(res, 404, 'Not found', 'text/plain');
    const types = { '.html': 'text/html', '.js': 'application/javascript', '.css': 'text/css', '.json': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
    res.writeHead(200, { 'Content-Type': `${types[path.extname(file)] || 'application/octet-stream'}; charset=utf-8` });
    fs.createReadStream(file).pipe(res);
  } catch (error) { send(res, 500, { error: error.message || 'Server error' }); }
});

server.listen(PORT, () => console.log(`Factory SOS running at http://localhost:${PORT}`));

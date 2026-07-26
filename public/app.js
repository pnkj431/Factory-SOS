const $ = id => document.getElementById(id);
const deviceName = localStorage.deviceName || `Tablet-${Math.random().toString(36).slice(2, 7).toUpperCase()}`;
localStorage.deviceName = deviceName;
let adminToken = sessionStorage.adminToken || '';
if ('serviceWorker' in navigator) navigator.serviceWorker.register('/sw.js');
$('openSos').onclick = () => { $('sosStatus').textContent = ''; $('sosDialog').showModal(); };
$('sosForm').addEventListener('submit', async event => {
  event.preventDefault(); const button = event.submitter; button.disabled = true; $('sosStatus').textContent = 'Sending request...';
  const payload = { issue: $('issue').value, workerName: $('workerName').value, location: $('location').value, note: $('note').value, deviceName };
  try { const response = await fetch('/api/sos', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) }); const result = await response.json(); if (!response.ok) throw new Error(result.error); $('sosStatus').textContent = result.email.sent ? 'SOS sent. Management has been emailed.' : 'SOS saved. Ask IT to complete email setup if alerts are not arriving.'; setTimeout(() => $('sosDialog').close(), 2200); }
  catch { $('sosStatus').textContent = 'Could not connect. Please try again or contact your supervisor.'; }
  finally { button.disabled = false; }
});
$('openAdmin').onclick = () => { $('adminDialog').showModal(); if (adminToken) showSettings(); };
$('closeAdmin').onclick = () => $('adminDialog').close();
$('loginButton').onclick = async () => { $('loginStatus').textContent = 'Signing in...'; const response = await fetch('/api/admin/login', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ password: $('adminPassword').value }) }); const data = await response.json(); if (!response.ok) return $('loginStatus').textContent = data.error; adminToken = data.token; sessionStorage.adminToken = adminToken; showSettings(); };
async function api(url, options = {}) { return fetch(url, { ...options, headers: { ...(options.headers || {}), Authorization: `Bearer ${adminToken}`, 'Content-Type': 'application/json' } }); }
async function showSettings() { $('loginArea').hidden = true; $('settingsArea').hidden = false; const response = await api('/api/admin/settings'); if (!response.ok) { adminToken = ''; sessionStorage.removeItem('adminToken'); return; } const data = await response.json(); const emails = data.managerEmails || ['', '', '', '', '']; for (let index = 0; index < 5; index++) $(`managerEmail${index + 1}`).value = emails[index] || ''; for (const key of ['smtpHost','smtpPort','smtpUser','fromName']) $(key).value = data[key] || ''; $('smtpSecure').checked = data.smtpSecure; loadRequests(); }
$('settingsForm').addEventListener('submit', async event => { event.preventDefault(); $('settingsStatus').textContent = 'Saving...'; const data = {}; for (const key of ['smtpHost','smtpPort','smtpUser','smtpPassword','fromName']) data[key] = $(key).value; data.managerEmails = [1, 2, 3, 4, 5].map(index => $(`managerEmail${index}`).value); data.smtpSecure = $('smtpSecure').checked; const response = await api('/api/admin/settings', { method: 'PUT', body: JSON.stringify(data) }); const result = await response.json(); $('settingsStatus').textContent = response.ok ? 'Email settings saved.' : (result.error || 'Could not save settings.'); if (response.ok) $('smtpPassword').value = ''; });
async function loadRequests() { const response = await api('/api/admin/requests'); const requests = await response.json(); $('requests').innerHTML = requests.length ? requests.slice(0, 12).map(r => `<div class="request"><b>${escapeHtml(r.issue)}</b><br>${escapeHtml(r.workerName || r.deviceName)} · ${escapeHtml(r.location || 'No location')}<br><time>${new Date(r.createdAt).toLocaleString()}</time></div>`).join('') : '<p class="hint">No SOS requests yet.</p>'; }
function escapeHtml(value) { const d = document.createElement('div'); d.textContent = value; return d.innerHTML; }

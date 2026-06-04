const express = require('express');
const fetch   = require('node-fetch');
const app     = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ── Безопасность: CORS только с разрешённых доменов ──
const ALLOWED_ORIGINS = ['https://kompas87.ru', 'https://www.kompas87.ru'];
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin) || !origin) {
    res.header('Access-Control-Allow-Origin', origin || '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── Rate limiting: не более 200 запросов в минуту с одного IP ──
const rateLimitMap = new Map();
app.use((req, res, next) => {
  const ip  = req.ip || req.connection.remoteAddress;
  const now = Date.now();
  const windowMs = 60000;
  const max = 200;
  if (!rateLimitMap.has(ip)) rateLimitMap.set(ip, []);
  const requests = rateLimitMap.get(ip).filter(t => now - t < windowMs);
  requests.push(now);
  rateLimitMap.set(ip, requests);
  if (requests.length > max) return res.status(429).json({ error: 'Too many requests' });
  next();
});

// Credentials только из переменных окружения — не из кода
function alfaCredentials() {
  const user = process.env.ALFA_USER;
  const pass = process.env.ALFA_PASS;
  if (!user || !pass) throw new Error('Alfa-Bank credentials not configured');
  return { userName: user, password: pass };
}

// ── МойСклад API ──
app.all('/proxy/*', async (req, res) => {
  const path  = req.path.replace('/proxy', '');
  const query = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
  const msUrl = 'https://api.moysklad.ru/api/remap/1.2' + path + query;
  try {
    const headers = { 'Authorization': 'Bearer ' + process.env.MS_TOKEN };
    if (req.method === 'POST' || req.method === 'PUT') headers['Content-Type'] = 'application/json';
    const options = { method: req.method, headers };
    if ((req.method === 'POST' || req.method === 'PUT') && req.body) options.body = JSON.stringify(req.body);
    console.log(req.method, msUrl);
    const response = await fetch(msUrl, options);
    const text = await response.text();
    res.status(response.status).header('Content-Type', 'application/json').send(text);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Альфа-Банк: регистрация платежа ──
app.post('/payment/register.do', async (req, res) => {
  try {
    const creds = alfaCredentials();
    const params = new URLSearchParams({ ...req.body, ...creds });
    console.log('PAYMENT register:', req.body.orderNumber, req.body.amount);
    const response = await fetch('https://alfa.rbsuat.com/payment/rest/register.do', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString()
    });
    const data = await response.json();
    console.log('PAYMENT result:', data.errorCode || 'OK');
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Альфа-Банк: статус платежа ──
app.post('/payment/getOrderStatus.do', async (req, res) => {
  try {
    const creds = alfaCredentials();
    const params = new URLSearchParams({ ...req.body, ...creds });
    const response = await fetch('https://alfa.rbsuat.com/payment/rest/getOrderStatus.do', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString()
    });
    const data = await response.json();
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Альфа-Банк: подтверждение списания ──
app.post('/payment/deposit.do', async (req, res) => {
  try {
    const creds = alfaCredentials();
    const params = new URLSearchParams({ ...req.body, ...creds });
    console.log('DEPOSIT:', req.body.orderId);
    const response = await fetch('https://alfa.rbsuat.com/payment/rest/deposit.do', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString()
    });
    const data = await response.json();
    console.log('DEPOSIT result:', data.errorCode || 'OK');
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Проксирование изображений МоегоСклада ──
app.get('/miniature/*', async (req, res) => {
  const path  = req.path.replace('/miniature', '');
  const query = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
  const imgUrl = 'https://miniature-prod.moysklad.ru' + path + query;
  try {
    const response = await fetch(imgUrl, { headers: { 'Authorization': 'Bearer ' + process.env.MS_TOKEN } });
    if (!response.ok) { res.status(response.status).send(''); return; }
    const buffer = await response.buffer();
    res.set('Content-Type', response.headers.get('content-type') || 'image/jpeg');
    res.set('Cache-Control', 'public, max-age=86400');
    res.send(buffer);
  } catch(e) {
    res.status(500).send('');
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Kompas Proxy running on port ' + PORT));

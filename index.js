const express = require('express');
const fetch   = require('node-fetch');
const app     = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health-check для Amvera: корень должен отдавать 200 (раньше был 404 → проба не проходила)
app.get('/', (req, res) => res.json({ ok: true, service: 'kompas-proxy' }));

// ── Безопасность: CORS только с разрешённых доменов ──
const ALLOWED_ORIGINS = ['https://kompas87.ru', 'https://www.kompas87.ru'];
// Локальная разработка: приложение, открытое через http://localhost:*/http://127.0.0.1:*
const isLocalDevOrigin = o => /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/.test(o);
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin) || isLocalDevOrigin(origin)) {
    res.header('Access-Control-Allow-Origin', origin);
  } else if (!origin && (req.path.startsWith('/payment/') || req.path.startsWith('/proxy/'))) {
    // Разрешаем без Origin только для внутренних запросов с сервера
    res.header('Access-Control-Allow-Origin', '*');
  }
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization, Accept');
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

// ── Временный код-замок приложения (на время тестирования эквайринга) ──
// Задайте APP_LOCK_PIN (6 цифр) в переменных окружения Amvera — приложение попросит код при входе.
// Уберите переменную и перезапустите сервис — замок исчезнет, менять код приложения не нужно.
const lockAttempts = new Map(); // ip → { n: попыток, t: начало окна }
app.get('/app-lock/status', (req, res) => {
  res.json({ locked: !!process.env.APP_LOCK_PIN });
});
app.post('/app-lock/check', (req, res) => {
  const pin = process.env.APP_LOCK_PIN;
  if (!pin) return res.json({ ok: true, locked: false });
  const ip = req.ip || req.connection.remoteAddress || '';
  const now = Date.now();
  const a = lockAttempts.get(ip) || { n: 0, t: now };
  if (now - a.t > 15 * 60000) { a.n = 0; a.t = now; }
  if (a.n >= 10) return res.status(429).json({ ok: false, error: 'too_many_attempts' });
  const ok = String((req.body && req.body.pin) || '') === String(pin);
  a.n = ok ? 0 : a.n + 1;
  lockAttempts.set(ip, a);
  if (!ok) console.warn('APP-LOCK: неверный код с', ip, '(попытка ' + a.n + '/10)');
  res.json({ ok });
});

// ── Серверная блокировка заказов между сборщиками ──
// Заказ одновременно собирает только один ТСД. Хранится в памяти: перезапуск сервиса
// сбрасывает блокировки, TTL 2 часа страхует от «зависших» (ТСД разрядился и т.п.).
const SBORKA_LOCK_TTL = 2 * 3600 * 1000;
const sborkaLocks = new Map(); // orderId → { name, t }
function cleanSborkaLocks() {
  const cutoff = Date.now() - SBORKA_LOCK_TTL;
  for (const [id, l] of sborkaLocks) if (!l || !l.t || l.t < cutoff) sborkaLocks.delete(id);
}
app.post('/sborka/lock', (req, res) => {
  cleanSborkaLocks();
  const orderId = String(req.body.orderId || '');
  const name = String(req.body.picker || '').slice(0, 60);
  if (!orderId || !name) return res.status(400).json({ error: 'orderId и picker обязательны' });
  const cur = sborkaLocks.get(orderId);
  if (cur && cur.name !== name) return res.json({ ok: false, by: cur.name, since: cur.t });
  sborkaLocks.set(orderId, { name, t: Date.now() });
  res.json({ ok: true });
});
app.post('/sborka/unlock', (req, res) => {
  const orderId = String(req.body.orderId || '');
  const name = String(req.body.picker || '');
  const cur = sborkaLocks.get(orderId);
  if (cur && cur.name === name) sborkaLocks.delete(orderId);
  res.json({ ok: true });
});
app.get('/sborka/locks', (req, res) => {
  cleanSborkaLocks();
  const out = {};
  for (const [id, l] of sborkaLocks) out[id] = { name: l.name, t: l.t };
  res.json(out);
});

// Заказы, видимые сборщику прямо сейчас — лёгкий опрос для нативной службы APK-обёртки ТСД.
// Кэш наполняется наблюдателем watchOrderStatuses (раз в 30 сек), лишней нагрузки на МС нет.
let pickerPendingCache = { at: 0, orders: [] };
app.get('/sborka/pending', (req, res) => {
  res.json(pickerPendingCache);
});

// ── WEB PUSH УВЕДОМЛЕНИЯ ──
// Требует: пакет web-push в package.json + env VAPID_PUBLIC_KEY / VAPID_PRIVATE_KEY
// (сгенерировать: npx web-push generate-vapid-keys). Подписки живут в /data — переживают рестарты.
let webpush = null;
try { webpush = require('web-push'); } catch(e) { console.warn('Пакет web-push не установлен — пуш-уведомления отключены'); }
const fs = require('fs');
const PUSH_STORE = process.env.PUSH_STORE || (fs.existsSync('/data') ? '/data/push-subs.json' : './push-subs.json');
let pushSubs = {}; // clientId (контрагент МС) → [{ sub, t }]
try { pushSubs = JSON.parse(fs.readFileSync(PUSH_STORE, 'utf8')) || {}; } catch(e) {}
function savePushSubs() {
  try { fs.writeFileSync(PUSH_STORE, JSON.stringify(pushSubs)); } catch(e) { console.warn('push store:', e.message); }
}
function pushEnabled() {
  return !!(webpush && process.env.VAPID_PUBLIC_KEY && process.env.VAPID_PRIVATE_KEY);
}
if (pushEnabled()) {
  webpush.setVapidDetails(
    process.env.VAPID_SUBJECT || 'mailto:info@kompas87.ru',
    process.env.VAPID_PUBLIC_KEY, process.env.VAPID_PRIVATE_KEY
  );
  console.log('Web Push: включён,', Object.keys(pushSubs).length, 'клиентов с подписками');
} else {
  console.log('Web Push: выключен (нужны пакет web-push и VAPID-ключи в env)');
}

app.get('/push/vapid-public-key', (req, res) => {
  res.json({ key: pushEnabled() ? process.env.VAPID_PUBLIC_KEY : null });
});

app.post('/push/subscribe', (req, res) => {
  try {
    const clientId = String(req.body.clientId || '').slice(0, 64);
    const sub = req.body.subscription;
    if (!clientId || !sub || typeof sub.endpoint !== 'string' || !sub.endpoint.startsWith('https://')) {
      return res.status(400).json({ error: 'clientId и subscription обязательны' });
    }
    const list = (pushSubs[clientId] || []).filter(s => s.sub.endpoint !== sub.endpoint);
    list.push({ sub, t: Date.now() });
    pushSubs[clientId] = list.slice(-5); // максимум 5 устройств на клиента
    savePushSubs();
    console.log('PUSH subscribe:', clientId, 'устройств:', pushSubs[clientId].length);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

app.post('/push/unsubscribe', (req, res) => {
  const endpoint = req.body && req.body.endpoint;
  if (endpoint) {
    let changed = false;
    for (const cid of Object.keys(pushSubs)) {
      const filtered = pushSubs[cid].filter(s => s.sub.endpoint !== endpoint);
      if (filtered.length !== pushSubs[cid].length) changed = true;
      if (filtered.length) pushSubs[cid] = filtered; else delete pushSubs[cid];
    }
    if (changed) savePushSubs();
  }
  res.json({ ok: true });
});

// Отправка пуша на все устройства клиента; умершие подписки (404/410) вычищаются
async function sendPushToClient(clientId, title, body) {
  if (!pushEnabled() || !clientId) return 0;
  const list = pushSubs[clientId] || [];
  let sent = 0, changed = false;
  for (const item of list.slice()) {
    try {
      await webpush.sendNotification(item.sub, JSON.stringify({ title, body, url: '/' }), { TTL: 3600 });
      sent++;
    } catch(e) {
      if (e.statusCode === 404 || e.statusCode === 410) {
        pushSubs[clientId] = (pushSubs[clientId] || []).filter(s => s.sub.endpoint !== item.sub.endpoint);
        if (!pushSubs[clientId].length) delete pushSubs[clientId];
        changed = true;
      } else console.warn('push send:', e.statusCode || e.message);
    }
  }
  if (changed) savePushSubs();
  return sent;
}
function agentIdFromOrder(o) {
  const href = (o.agent && o.agent.meta && o.agent.meta.href) || '';
  return href.split('/').pop().split('?')[0] || null;
}

// Credentials только из переменных окружения — не из кода.
// Если пароль содержит символы, которые панель не принимает (например «!»),
// задайте ALFA_PASS_B64 = пароль в base64 — он имеет приоритет над ALFA_PASS.
function alfaCredentials() {
  const user = process.env.ALFA_USER;
  const pass = process.env.ALFA_PASS_B64
    ? Buffer.from(process.env.ALFA_PASS_B64, 'base64').toString('utf8').trim()
    : process.env.ALFA_PASS;
  if (!user || !pass) throw new Error('Alfa-Bank credentials not configured');
  return { userName: user, password: pass };
}

// ── Сертификаты УЦ Минцифры («Russian Trusted CA») ──
// payment.alfabank.ru работает на сертификате российского УЦ, которого нет в
// стандартном хранилище Node.js — без него все запросы к Альфе падают с ошибкой
// «self-signed certificate in certificate chain». Добавляем корневой и промежуточный
// сертификаты Минцифры к стандартным доверенным для всех исходящих HTTPS-запросов.
// Источник: https://www.gosuslugi.ru/crt (проверены по официальным отпечаткам).
const https = require('https');
const tls   = require('tls');
const RUSSIAN_TRUSTED_CA = `-----BEGIN CERTIFICATE-----
MIIFwjCCA6qgAwIBAgICEAAwDQYJKoZIhvcNAQELBQAwcDELMAkGA1UEBhMCUlUx
PzA9BgNVBAoMNlRoZSBNaW5pc3RyeSBvZiBEaWdpdGFsIERldmVsb3BtZW50IGFu
ZCBDb21tdW5pY2F0aW9uczEgMB4GA1UEAwwXUnVzc2lhbiBUcnVzdGVkIFJvb3Qg
Q0EwHhcNMjIwMzAxMjEwNDE1WhcNMzIwMjI3MjEwNDE1WjBwMQswCQYDVQQGEwJS
VTE/MD0GA1UECgw2VGhlIE1pbmlzdHJ5IG9mIERpZ2l0YWwgRGV2ZWxvcG1lbnQg
YW5kIENvbW11bmljYXRpb25zMSAwHgYDVQQDDBdSdXNzaWFuIFRydXN0ZWQgUm9v
dCBDQTCCAiIwDQYJKoZIhvcNAQEBBQADggIPADCCAgoCggIBAMfFOZ8pUAL3+r2n
qqE0Zp52selXsKGFYoG0GM5bwz1bSFtCt+AZQMhkWQheI3poZAToYJu69pHLKS6Q
XBiwBC1cvzYmUYKMYZC7jE5YhEU2bSL0mX7NaMxMDmH2/NwuOVRj8OImVa5s1F4U
zn4Kv3PFlDBjjSjXKVY9kmjUBsXQrIHeaqmUIsPIlNWUnimXS0I0abExqkbdrXbX
YwCOXhOO2pDUx3ckmJlCMUGacUTnylyQW2VsJIyIGA8V0xzdaeUXg0VZ6ZmNUr5Y
Ber/EAOLPb8NYpsAhJe2mXjMB/J9HNsoFMBFJ0lLOT/+dQvjbdRZoOT8eqJpWnVD
U+QL/qEZnz57N88OWM3rabJkRNdU/Z7x5SFIM9FrqtN8xewsiBWBI0K6XFuOBOTD
4V08o4TzJ8+Ccq5XlCUW2L48pZNCYuBDfBh7FxkB7qDgGDiaftEkZZfApRg2E+M9
G8wkNKTPLDc4wH0FDTijhgxR3Y4PiS1HL2Zhw7bD3CbslmEGgfnnZojNkJtcLeBH
BLa52/dSwNU4WWLubaYSiAmA9IUMX1/RpfpxOxd4Ykmhz97oFbUaDJFipIggx5sX
ePAlkTdWnv+RWBxlJwMQ25oEHmRguNYf4Zr/Rxr9cS93Y+mdXIZaBEE0KS2iLRqa
OiWBki9IMQU4phqPOBAaG7A+eP8PAgMBAAGjZjBkMB0GA1UdDgQWBBTh0YHlzlpf
BKrS6badZrHF+qwshzAfBgNVHSMEGDAWgBTh0YHlzlpfBKrS6badZrHF+qwshzAS
BgNVHRMBAf8ECDAGAQH/AgEEMA4GA1UdDwEB/wQEAwIBhjANBgkqhkiG9w0BAQsF
AAOCAgEAALIY1wkilt/urfEVM5vKzr6utOeDWCUczmWX/RX4ljpRdgF+5fAIS4vH
tmXkqpSCOVeWUrJV9QvZn6L227ZwuE15cWi8DCDal3Ue90WgAJJZMfTshN4OI8cq
W9E4EG9wglbEtMnObHlms8F3CHmrw3k6KmUkWGoa+/ENmcVl68u/cMRl1JbW2bM+
/3A+SAg2c6iPDlehczKx2oa95QW0SkPPWGuNA/CE8CpyANIhu9XFrj3RQ3EqeRcS
AQQod1RNuHpfETLU/A2gMmvn/w/sx7TB3W5BPs6rprOA37tutPq9u6FTZOcG1Oqj
C/B7yTqgI7rbyvox7DEXoX7rIiEqyNNUguTk/u3SZ4VXE2kmxdmSh3TQvybfbnXV
4JbCZVaqiZraqc7oZMnRoWrXRG3ztbnbes/9qhRGI7PqXqeKJBztxRTEVj8ONs1d
WN5szTwaPIvhkhO3CO5ErU2rVdUr89wKpNXbBODFKRtgxUT70YpmJ46VVaqdAhOZ
D9EUUn4YaeLaS8AjSF/h7UkjOibNc4qVDiPP+rkehFWM66PVnP1Msh93tc+taIfC
EYVMxjh8zNbFuoc7fzvvrFILLe7ifvEIUqSVIC/AzplM/Jxw7buXFeGP1qVCBEHq
391d/9RAfaZ12zkwFsl+IKwE/OZxW8AHa9i1p4GO0YSNuczzEm4=
-----END CERTIFICATE-----
-----BEGIN CERTIFICATE-----
MIIHQjCCBSqgAwIBAgICEAIwDQYJKoZIhvcNAQELBQAwcDELMAkGA1UEBhMCUlUx
PzA9BgNVBAoMNlRoZSBNaW5pc3RyeSBvZiBEaWdpdGFsIERldmVsb3BtZW50IGFu
ZCBDb21tdW5pY2F0aW9uczEgMB4GA1UEAwwXUnVzc2lhbiBUcnVzdGVkIFJvb3Qg
Q0EwHhcNMjIwMzAyMTEyNTE5WhcNMjcwMzA2MTEyNTE5WjBvMQswCQYDVQQGEwJS
VTE/MD0GA1UECgw2VGhlIE1pbmlzdHJ5IG9mIERpZ2l0YWwgRGV2ZWxvcG1lbnQg
YW5kIENvbW11bmljYXRpb25zMR8wHQYDVQQDDBZSdXNzaWFuIFRydXN0ZWQgU3Vi
IENBMIICIjANBgkqhkiG9w0BAQEFAAOCAg8AMIICCgKCAgEA9YPqBKOk19NFymrE
wehzrhBEgT2atLezpduB24mQ7CiOa/HVpFCDRZzdxqlh8drku408/tTmWzlNH/br
HuQhZ/miWKOf35lpKzjyBd6TPM23uAfJvEOQ2/dnKGGJbsUo1/udKSvxQwVHpVv3
S80OlluKfhWPDEXQpgyFqIzPoxIQTLZ0deirZwMVHarZ5u8HqHetRuAtmO2ZDGQn
vVOJYAjls+Hiueq7Lj7Oce7CQsTwVZeP+XQx28PAaEZ3y6sQEt6rL06ddpSdoTMp
BnCqTbxW+eWMyjkIn6t9GBtUV45yB1EkHNnj2Ex4GwCiN9T84QQjKSr+8f0psGrZ
vPbCbQAwNFJjisLixnjlGPLKa5vOmNwIh/LAyUW5DjpkCx004LPDuqPpFsKXNKpa
L2Dm6uc0x4Jo5m+gUTVORB6hOSzWnWDj2GWfomLzzyjG81DRGFBpco/O93zecsIN
3SL2Ysjpq1zdoS01CMYxie//9zWvYwzI25/OZigtnpCIrcd2j1Y6dMUFQAzAtHE+
qsXflSL8HIS+IJEFIQobLlYhHkoE3avgNx5jlu+OLYe0dF0Ykx1PGNjbwqvTX37R
Cn32NMjlotW2QcGEZhDKj+3urZizp5xdTPZitA+aEjZM/Ni71VOdiOP0igbw6asZ
2fxdozZ1TnSSYNYvNATwthNmZysCAwEAAaOCAeUwggHhMBIGA1UdEwEB/wQIMAYB
Af8CAQAwDgYDVR0PAQH/BAQDAgGGMB0GA1UdDgQWBBTR4XENCy2BTm6KSo9MI7NM
XqtpCzAfBgNVHSMEGDAWgBTh0YHlzlpfBKrS6badZrHF+qwshzCBxwYIKwYBBQUH
AQEEgbowgbcwOwYIKwYBBQUHMAKGL2h0dHA6Ly9yb3N0ZWxlY29tLnJ1L2NkcC9y
b290Y2Ffc3NsX3JzYTIwMjIuY3J0MDsGCCsGAQUFBzAChi9odHRwOi8vY29tcGFu
eS5ydC5ydS9jZHAvcm9vdGNhX3NzbF9yc2EyMDIyLmNydDA7BggrBgEFBQcwAoYv
aHR0cDovL3JlZXN0ci1wa2kucnUvY2RwL3Jvb3RjYV9zc2xfcnNhMjAyMi5jcnQw
gbAGA1UdHwSBqDCBpTA1oDOgMYYvaHR0cDovL3Jvc3RlbGVjb20ucnUvY2RwL3Jv
b3RjYV9zc2xfcnNhMjAyMi5jcmwwNaAzoDGGL2h0dHA6Ly9jb21wYW55LnJ0LnJ1
L2NkcC9yb290Y2Ffc3NsX3JzYTIwMjIuY3JsMDWgM6Axhi9odHRwOi8vcmVlc3Ry
LXBraS5ydS9jZHAvcm9vdGNhX3NzbF9yc2EyMDIyLmNybDANBgkqhkiG9w0BAQsF
AAOCAgEARBVzZls79AdiSCpar15dA5Hr/rrT4WbrOfzlpI+xrLeRPrUG6eUWIW4v
Sui1yx3iqGLCjPcKb+HOTwoRMbI6ytP/ndp3TlYua2advYBEhSvjs+4vDZNwXr/D
anbwIWdurZmViQRBDFebpkvnIvru/RpWud/5r624Wp8voZMRtj/cm6aI9LtvBfT9
cfzhOaexI/99c14dyiuk1+6QhdwKaCRTc1mdfNQmnfWNRbfWhWBlK3h4GGE9JK33
Gk8ZS8DMrkdAh0xby4xAQ/mSWAfWrBmfzlOqGyoB1U47WTOeqNbWkkoAP2ys94+s
Jg4NTkiDVtXRF6nr6fYi0bSOvOFg0IQrMXO2Y8gyg9ARdPJwKtvWX8VPADCYMiWH
h4n8bZokIrImVKLDQKHY4jCsND2HHdJfnrdL2YJw1qFskNO4cSNmZydw0Wkgjv9k
F+KxqrDKlB8MZu2Hclph6v/CZ0fQ9YuE8/lsHZ0Qc2HyiSMnvjgK5fDc3TD4fa8F
E8gMNurM+kV8PT8LNIM+4Zs+LKEV8nqRWBaxkIVJGekkVKO8xDBOG/aN62AZKHOe
GcyIdu7yNMMRihGVZCYr8rYiJoKiOzDqOkPkLOPdhtVlgnhowzHDxMHND/E2WA5p
ZHuNM/m0TXt2wTTPL7JH2YC0gPz/BvvSzjksgzU5rLbRyUKQkgU=
-----END CERTIFICATE-----`;
https.globalAgent.options.ca = [...tls.rootCertificates, RUSSIAN_TRUSTED_CA];

// Среда Альфа-Банка: без ALFA_API_BASE — тестовая (rbsuat), боевая задаётся в env Amvera:
// ALFA_API_BASE=https://payment.alfabank.ru/payment/rest (+ боевые ALFA_USER/ALFA_PASS)
const ALFA_API = (process.env.ALFA_API_BASE || 'https://alfa.rbsuat.com/payment/rest').replace(/\/+$/, '');
console.log('Alfa API среда:', ALFA_API.includes('rbsuat') ? 'ТЕСТОВАЯ (' + ALFA_API + ')' : 'БОЕВАЯ (' + ALFA_API + ')');

// ── МойСклад API ──
const ALLOWED_MS_PATHS = [
  '/entity/assortment',
  '/entity/customerorder',
  '/entity/counterparty',
  '/entity/store',
  '/entity/retailstore',
  '/entity/product',
  '/entity/demand',
  '/entity/employee',
  '/entity/organization',
  '/entity/currency',
  '/report/stock',
  '/context/employee',
];

// Валидация суммы платежа (не менее 100 копеек = 1 рубль)
const MIN_PAYMENT = 100;
const MAX_PAYMENT = 99999900; // 999 999 ₽

app.all('/proxy/*', async (req, res) => {
  const path  = req.path.replace('/proxy', '');
  const query = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';

  // Проверяем что путь разрешён
  const allowed = ALLOWED_MS_PATHS.some(p => path.startsWith(p));
  if (!allowed) {
    console.warn('BLOCKED path:', path, 'from:', req.ip);
    return res.status(403).json({ error: 'Forbidden' });
  }

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

// Диагностика конфигурации Альфы (без секретов — только наличие и длины).
// Защищено кодом замка: /payment/env-check?pin=<APP_LOCK_PIN>
app.get('/payment/env-check', (req, res) => {
  const gate = process.env.APP_LOCK_PIN;
  if (!gate || String(req.query.pin || '') !== String(gate)) return res.status(403).json({ error: 'forbidden' });
  let b64ok = null, passSrc = 'none', passLen = 0;
  if (process.env.ALFA_PASS_B64) {
    try {
      const decoded = Buffer.from(process.env.ALFA_PASS_B64, 'base64').toString('utf8').trim();
      b64ok = decoded.length > 0;
      passSrc = 'ALFA_PASS_B64';
      passLen = decoded.length;
    } catch(e) { b64ok = false; }
  } else if (process.env.ALFA_PASS) {
    passSrc = 'ALFA_PASS';
    passLen = process.env.ALFA_PASS.length;
  }
  res.json({
    alfaApi:  ALFA_API,
    userSet:  !!process.env.ALFA_USER,
    userLen:  (process.env.ALFA_USER || '').length,
    passSrc:  passSrc,   // какая переменная используется для пароля
    passLen:  passLen,   // длина пароля после декодирования/как есть
    b64ok:    b64ok,     // true = ALFA_PASS_B64 декодировалась без ошибок
    push: {
      module:    !!webpush,                          // false = пакет web-push не установился (package.json?)
      vapidPub:  !!process.env.VAPID_PUBLIC_KEY,
      vapidPriv: !!process.env.VAPID_PRIVATE_KEY,
      pubLen:    (process.env.VAPID_PUBLIC_KEY || '').length,   // должно быть 87
      privLen:   (process.env.VAPID_PRIVATE_KEY || '').length,  // должно быть 43
      enabled:   pushEnabled(),
      clients:   Object.keys(pushSubs).length,
      store:     PUSH_STORE
    }
  });
});

// ── Альфа-Банк: регистрация платежа ──
app.post('/payment/register.do', async (req, res) => {
  try {
    const creds = alfaCredentials();
    // Валидация суммы
    const amount = parseInt(req.body.amount || 0);
    if (!amount || amount < MIN_PAYMENT || amount > MAX_PAYMENT) {
      console.warn('PAYMENT invalid amount:', amount);
      return res.status(400).json({ error: 'Invalid amount' });
    }
    const params = new URLSearchParams({ ...req.body, ...creds });
    console.log('PAYMENT register:', req.body.orderNumber, amount);
    const response = await fetch(ALFA_API + '/register.do', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString()
    });
    const data = await response.json();
    console.log('PAYMENT result:', data.errorCode || 'OK');
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Альфа-Банк: ХОЛД (двухстадийная оплата — преавторизация) ──
app.post('/payment/registerPreAuth.do', async (req, res) => {
  try {
    const creds = alfaCredentials();
    const amount = parseInt(req.body.amount || 0);
    if (!amount || amount < MIN_PAYMENT || amount > MAX_PAYMENT) {
      console.warn('PREAUTH invalid amount:', amount);
      return res.status(400).json({ error: 'Invalid amount' });
    }
    const params = new URLSearchParams({ ...req.body, ...creds });
    console.log('PREAUTH register:', req.body.orderNumber, amount);
    const response = await fetch(ALFA_API + '/registerPreAuth.do', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString()
    });
    const data = await response.json();
    console.log('PREAUTH result:', data.errorCode || 'OK');
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
    const response = await fetch(ALFA_API + '/getOrderStatus.do', {
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
    const response = await fetch(ALFA_API + '/deposit.do', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString()
    });
    const data = await response.json();
    console.log('DEPOSIT result:', data.errorCode || 'OK');
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Альфа-Банк: ОТМЕНА ХОЛДА (заказ отменён до списания) ──
app.post('/payment/reverse.do', async (req, res) => {
  try {
    const creds = alfaCredentials();
    const params = new URLSearchParams({ ...req.body, ...creds });
    console.log('REVERSE:', req.body.orderId);
    const response = await fetch(ALFA_API + '/reverse.do', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: params.toString()
    });
    const data = await response.json();
    console.log('REVERSE result:', data.errorCode || 'OK');
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Двухстадийная оплата: сохранение alfaOrderId в заказ и списание холда ──
// meta доп.поля «Alfa orderId» у заказа покупателя (ищем по имени)
let _alfaAttrMeta = null;
async function getAlfaAttrMeta() {
  if (_alfaAttrMeta) return _alfaAttrMeta;
  try {
    const r = await fetch(MS_API + '/entity/customerorder/metadata/attributes', { headers: msAuthHeaders() });
    const data = await r.json();
    const attr = (data.rows || []).find(a => a.name === 'Alfa orderId');
    if (attr) _alfaAttrMeta = attr.meta;
    else console.warn('Доп.поле «Alfa orderId» не найдено у заказа покупателя');
  } catch(e) { console.error('getAlfaAttrMeta:', e.message); }
  return _alfaAttrMeta;
}

// Приложение клиента вызывает после оплаты — сохраняем alfaOrderId в заказ
app.post('/payment/save-order-id', async (req, res) => {
  try {
    const msOrderId = req.body.msOrderId, alfaOrderId = req.body.alfaOrderId;
    if (!msOrderId || !alfaOrderId) return res.status(400).json({ error: 'msOrderId и alfaOrderId обязательны' });
    const meta = await getAlfaAttrMeta();
    if (!meta) return res.status(500).json({ error: 'attr_not_found' });
    const r = await fetch(MS_API + '/entity/customerorder/' + msOrderId, {
      method: 'PUT', headers: msAuthHeaders(true),
      body: JSON.stringify({ attributes: [{ meta, value: String(alfaOrderId) }] })
    });
    if (!r.ok) { const t = await r.text(); console.warn('save-order-id MS', r.status, t.slice(0,150)); return res.status(502).json({ error: 'moysklad_' + r.status }); }
    console.log('Saved alfaOrderId', alfaOrderId, '→ order', msOrderId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Приложение сборщика вызывает на «Заказ собран» — списываем удержанную сумму
app.post('/payment/capture', async (req, res) => {
  try {
    const creds = alfaCredentials();
    const msOrderId = req.body.msOrderId;
    if (!msOrderId) return res.status(400).json({ error: 'msOrderId обязателен' });
    // 1. находим alfaOrderId в заказе (+ отгрузки для расчёта фактической суммы)
    const oRes = await fetch(MS_API + '/entity/customerorder/' + msOrderId + '?expand=demands', { headers: msAuthHeaders() });
    const order = await oRes.json();
    const attr = (order.attributes || []).find(a => a.name === 'Alfa orderId');
    const alfaOrderId = attr && attr.value;
    if (!alfaOrderId) return res.json({ ok: false, reason: 'no_online_payment' }); // наличные — нечего списывать
    // 2. узнаём удержанную сумму и статус
    const stParams = new URLSearchParams({ orderId: alfaOrderId, ...creds });
    const stRes = await fetch(ALFA_API + '/getOrderStatusExtended.do', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: stParams.toString()
    });
    const st = await stRes.json();
    const os = st.orderStatus ?? st.OrderStatus;          // устойчиво к регистру поля
    const amount = parseInt(st.amount ?? st.Amount ?? 0);
    if (os === 2) return res.json({ ok: true, already: true });   // уже списан (идемпотентность)
    if (os !== 1 || !amount) return res.json({ ok: false, reason: 'not_held', status: st });
    // 3. фактическая сумма списания: холд = товары − бонусы + доставка; если при сборке
    //    товары заменили/убрали, отгрузка дешевле заказа — уменьшаем списание на разницу,
    //    остаток холда банк разблокирует автоматически (частичный deposit)
    let captureAmount = amount;
    try {
      const demands = order.demands || [];
      // demands могли прийти meta-ссылками без sum — дозагружаем
      for (const d of demands) {
        if (typeof d.sum !== 'number' && d.meta && d.meta.href) {
          const dr = await fetch(d.meta.href, { headers: msAuthHeaders() });
          if (dr.ok) { const dd = await dr.json(); if (typeof dd.sum === 'number') d.sum = dd.sum; }
        }
      }
      const demandSum = demands.reduce((s, d) => s + (typeof d.sum === 'number' ? d.sum : 0), 0);
      const orderSum = order.sum || 0;
      if (demandSum > 0 && orderSum > 0 && demandSum < orderSum) {
        const shortfall = orderSum - demandSum; // копейки
        captureAmount = Math.max(MIN_PAYMENT, Math.min(amount, amount - shortfall));
        console.log('CAPTURE частичное: заказ', orderSum, 'отгружено', demandSum, 'холд', amount, '→ списание', captureAmount);
      }
    } catch(e) { console.warn('CAPTURE: не удалось уточнить сумму отгрузки —', e.message, '— списываем полный холд'); }
    const depParams = new URLSearchParams({ orderId: alfaOrderId, amount: String(captureAmount), ...creds });
    const depRes = await fetch(ALFA_API + '/deposit.do', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: depParams.toString()
    });
    const dep = await depRes.json();
    const okDep = !dep.errorCode || dep.errorCode === '0';
    console.log('CAPTURE order', msOrderId, 'amount', captureAmount, 'of', amount, okDep ? 'OK' : dep.errorMessage);
    res.json({ ok: okDep, amount: captureAmount, held: amount, deposit: dep });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Отмена заказа: снять холд (reverse) или вернуть деньги (refund) + статус «Отменён»
const CANCELLED_STATE = '6b95153d-02a8-11ed-0a80-073c00232c3e';
app.post('/payment/cancel', async (req, res) => {
  try {
    const creds = alfaCredentials();
    const msOrderId = req.body.msOrderId;
    if (!msOrderId) return res.status(400).json({ error: 'msOrderId обязателен' });
    // alfaOrderId из заказа
    const oRes = await fetch(MS_API + '/entity/customerorder/' + msOrderId, { headers: msAuthHeaders() });
    const order = await oRes.json();
    const attr = (order.attributes || []).find(a => a.name === 'Alfa orderId');
    const alfaOrderId = attr && attr.value;
    let payment = { action: 'none', reason: 'no_online_payment' };
    if (alfaOrderId) {
      const stParams = new URLSearchParams({ orderId: alfaOrderId, ...creds });
      const stRes = await fetch(ALFA_API + '/getOrderStatusExtended.do', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: stParams.toString()
      });
      const st = await stRes.json();
      const os = st.orderStatus ?? st.OrderStatus;
      const amount = parseInt(st.amount ?? st.Amount ?? 0);
      if (os === 1) {                                   // холд не списан → снимаем
        const p = new URLSearchParams({ orderId: alfaOrderId, ...creds });
        const r = await fetch(ALFA_API + '/reverse.do', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: p.toString()
        });
        payment = { action: 'reverse', result: await r.json() };
      } else if (os === 2) {                            // уже списан → полный возврат
        const p = new URLSearchParams({ orderId: alfaOrderId, amount: String(amount), ...creds });
        const r = await fetch(ALFA_API + '/refund.do', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: p.toString()
        });
        payment = { action: 'refund', result: await r.json() };
      } else {
        payment = { action: 'none', orderStatus: os };
      }
    }
    // статус «Отменён» + причина отмены в Комментарий заказа
    const updBody = { state: { meta: { href: MS_API + '/entity/customerorder/metadata/states/' + CANCELLED_STATE, type: 'state', mediaType: 'application/json' } } };
    const reason = (req.body.reason || '').toString().trim().slice(0, 500);
    if (reason) {
      const who = req.body.by ? (' (' + String(req.body.by).slice(0, 40) + ')') : '';
      updBody.description = '❌ Причина отмены' + who + ': ' + reason + (order.description ? '\n\n' + order.description : '');
    }
    const upd = await fetch(MS_API + '/entity/customerorder/' + msOrderId, {
      method: 'PUT', headers: msAuthHeaders(true),
      body: JSON.stringify(updBody)
    });
    console.log('CANCEL order', msOrderId, '→', payment.action, '| MS', upd.status, '| reason:', reason || '—');
    res.json({ ok: upd.ok, payment });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Серверная смена статуса заказа (надёжнее прямого браузерного PUT)
app.post('/order/set-state', async (req, res) => {
  try {
    const msOrderId = req.body.msOrderId, stateId = req.body.stateId;
    if (!msOrderId || !stateId) return res.status(400).json({ error: 'msOrderId и stateId обязательны' });
    const r = await fetch(MS_API + '/entity/customerorder/' + msOrderId, {
      method: 'PUT', headers: msAuthHeaders(true),
      body: JSON.stringify({ state: { meta: { href: MS_API + '/entity/customerorder/metadata/states/' + stateId, type: 'state', mediaType: 'application/json' } } })
    });
    if (!r.ok) { const t = await r.text(); console.warn('set-state MS', r.status, t.slice(0,150)); return res.status(502).json({ error: 'moysklad_' + r.status }); }
    console.log('SET-STATE order', msOrderId, '→', stateId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// Курьер принимает заказ: пишем его имя+телефон в Комментарий + шлём клиенту «В пути» в Telegram
app.post('/order/accept', async (req, res) => {
  try {
    const msOrderId = req.body.msOrderId;
    const courierName  = (req.body.courierName  || '').toString().trim().slice(0, 80);
    const courierPhone = (req.body.courierPhone || '').toString().trim().slice(0, 30);
    if (!msOrderId || !courierName || !courierPhone) return res.status(400).json({ error: 'msOrderId, courierName, courierPhone обязательны' });
    const oRes = await fetch(MS_API + '/entity/customerorder/' + msOrderId + '?expand=agent', { headers: msAuthHeaders() });
    const order = await oRes.json();
    // дописываем курьера в комментарий (прежнюю строку курьера, если была, заменяем)
    const baseDesc = (order.description || '').replace(/^🛵 Курьер:.*(\r?\n)?/m, '').trim();
    const newDesc = '🛵 Курьер: ' + courierName + ' | ' + courierPhone + (baseDesc ? '\n\n' + baseDesc : '');
    const upd = await fetch(MS_API + '/entity/customerorder/' + msOrderId, {
      method: 'PUT', headers: msAuthHeaders(true),
      body: JSON.stringify({ description: newDesc })
    });
    if (!upd.ok) { const t = await upd.text(); console.warn('accept MS', upd.status, t.slice(0,150)); return res.status(502).json({ error: 'moysklad_' + upd.status }); }
    // Уведомление клиенту «В пути» с контактами курьера: Telegram + web push
    const inTransitMsg = '🛵 Заказ ' + (order.name || '') + ' уже в пути!\nКурьер: ' + courierName + '\nТелефон: ' + courierPhone;
    const chatId = await getChatIdForOrder(order);
    if (chatId && process.env.TG_BOT_TOKEN) {
      await tgSend(process.env.TG_BOT_TOKEN, chatId, inTransitMsg);
    }
    sendPushToClient(agentIdFromOrder(order), 'Компас.Доставка', inTransitMsg).catch(() => {});
    console.log('ACCEPT order', msOrderId, 'courier', courierName);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
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


// ── VK ID: данные пользователя по access_token ──
// Токен приходит с клиента после VKID.Auth.exchangeCode (PKCE, секрет не нужен).
// user_info возвращает имя, телефон и email (при scope 'phone email' в виджете).
const VK_APP_ID = process.env.VK_APP_ID || '54713637';

app.post('/vk/userinfo', async (req, res) => {
  const token = (req.body.access_token || '').trim();
  if (!token) return res.status(400).json({ error: 'Нет access_token' });
  try {
    const r = await fetch('https://id.vk.com/oauth2/user_info', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'client_id=' + encodeURIComponent(VK_APP_ID) + '&access_token=' + encodeURIComponent(token),
      signal: AbortSignal.timeout(10000)
    });
    const data = await r.json();
    if (data.error || !data.user) {
      console.error('VK user_info:', data.error || 'нет user', data.error_description || '');
      return res.status(401).json({ error: 'VK не подтвердил вход. Попробуйте ещё раз.' });
    }
    res.json({ user: data.user });
  } catch (e) {
    console.error('VK user_info error:', e.message);
    res.status(500).json({ error: 'Не удалось получить данные VK' });
  }
});


// ── Восстановление пароля по email ──
const nodemailer = require('nodemailer');

app.post('/mail/recovery', async (req, res) => {
  const email   = (req.body.email || '').trim();
  const agentId = req.body.agentId;
  if (!email || !agentId) {
    return res.status(400).json({ error: 'Не указан email' });
  }

  try {
    // Получаем пароль контрагента из МоегоСклада
    const agentR = await fetch('https://api.moysklad.ru/api/remap/1.2/entity/counterparty/' + agentId, {
      headers: { 'Authorization': 'Bearer ' + process.env.MS_TOKEN }
    });
    const agent = await agentR.json();
    const passAttr = agent.attributes && agent.attributes.find(a => a.name === 'Пароль');

    // Пароль хранится в виде хеша — восстановить нельзя, генерируем новый
    // Генерируем временный пароль
    const newPass = Math.random().toString(36).slice(-8);

    // Обновляем пароль контрагента (хеш на стороне приложения, тут простой)
    // Сохраняем новый пароль как есть в атрибут (приложение хеширует при входе — нужен сырой)
    // Поэтому отправляем сырой пароль и сохраняем его хеш
    function hashPass(pass) {
      let h = 0; const str = 'kompas87_' + pass;
      for (let i = 0; i < str.length; i++) { h = ((h << 5) - h) + str.charCodeAt(i); h |= 0; }
      return 'h' + Math.abs(h).toString(36);
    }

    if (passAttr) {
      await fetch('https://api.moysklad.ru/api/remap/1.2/entity/counterparty/' + agentId, {
        method: 'PUT',
        headers: { 'Authorization': 'Bearer ' + process.env.MS_TOKEN, 'Content-Type': 'application/json' },
        body: JSON.stringify({ attributes: [{ meta: passAttr.meta, value: hashPass(newPass) }] })
      });
    }

    // Отправляем письмо
    const transporter = nodemailer.createTransport({
      host: 'smtp.mail.ru',
      port: 465,
      secure: true,
      auth: { user: process.env.MAIL_USER, pass: process.env.MAIL_PASS }
    });

    await transporter.sendMail({
      from: '"Компас.Доставка" <' + process.env.MAIL_USER + '>',
      to: email,
      subject: 'Восстановление доступа — Компас.Доставка',
      text: 'Здравствуйте!\n\nВаш новый пароль для входа в приложение Компас.Доставка:\n\n' + newPass +
            '\n\n⚠️ Никому не сообщайте свой пароль от аккаунта.\n\nЕсли вы не запрашивали восстановление — проигнорируйте это письмо.\n\nС уважением,\nКоманда Компас.Доставка',
      html: '<div style="font-family:Arial,sans-serif;max-width:480px;margin:0 auto">' +
            '<div style="background:#1F9B5E;color:#fff;padding:20px;border-radius:12px 12px 0 0;text-align:center">' +
            '<h2 style="margin:0">Компас.Доставка</h2></div>' +
            '<div style="padding:24px;background:#f9f9f9;border-radius:0 0 12px 12px">' +
            '<p>Здравствуйте!</p>' +
            '<p>Ваш новый пароль для входа в приложение:</p>' +
            '<div style="background:#fff;border:2px solid #1F9B5E;border-radius:10px;padding:16px;text-align:center;font-size:24px;font-weight:bold;letter-spacing:2px;color:#1F9B5E;margin:16px 0">' + newPass + '</div>' +
            '<p style="color:#E24B4A;font-weight:bold">⚠️ Никому не сообщайте свой пароль от аккаунта.</p>' +
            '<p style="color:#888;font-size:13px">Если вы не запрашивали восстановление — проигнорируйте это письмо.</p>' +
            '</div></div>'
    });

    console.log('Письмо восстановления отправлено на', email);
    res.json({ ok: true });
  } catch(e) {
    console.error('Mail recovery error:', e.message);
    res.status(500).json({ error: 'Не удалось отправить письмо' });
  }
});


// ── TELEGRAM ВХОД (вариант Б — запрос контакта) ──
const tgSessions = new Map(); // sessionId → { phone, status, tgPhone, expires }

// 1. Приложение создаёт сессию подтверждения
app.post('/tg/start', (req, res) => {
  const phone = (req.body.phone || '').replace(/\D/g, '');
  if (!phone || phone.length < 10) return res.status(400).json({ error: 'Неверный номер' });
  const sessionId = Math.random().toString(36).slice(2, 10);
  tgSessions.set(sessionId, { phone, status: 'pending', expires: Date.now() + 10*60*1000 });
  res.json({ ok: true, sessionId, botUrl: 'https://t.me/kompas87_bot?start=' + sessionId });
});

// 2. Приложение опрашивает статус подтверждения
app.get('/tg/status/:sessionId', (req, res) => {
  const s = tgSessions.get(req.params.sessionId);
  if (!s) return res.json({ status: 'expired' });
  if (Date.now() > s.expires) { tgSessions.delete(req.params.sessionId); return res.json({ status: 'expired' }); }
  res.json({ status: s.status, phone: s.phone, chatId: s.status === 'confirmed' ? (s.chatId || null) : null });
});

// 3. POLLING — прокси сам опрашивает Telegram (webhook не работает на Amvera)
let tgOffset = 0;
async function tgPoll() {
  const TG_TOKEN = process.env.TG_BOT_TOKEN;
  if (!TG_TOKEN) return;
  try {
    const r = await fetch('https://api.telegram.org/bot' + TG_TOKEN + '/getUpdates?offset=' + tgOffset + '&timeout=20', {
      signal: AbortSignal.timeout(25000)
    });
    const data = await r.json();
    if (!data.ok || !data.result) return;
    for (const update of data.result) {
      tgOffset = update.update_id + 1;
      await tgHandleUpdate(update, TG_TOKEN);
    }
  } catch(e) {
    // таймаут long-polling — нормально
  }
}

async function tgHandleUpdate(update, TG_TOKEN) {
  try {
    const msg = update.message;
    if (!msg) return;
    const chatId = msg.chat && msg.chat.id;
    const SUPPORT_CHAT_ID = process.env.SUPPORT_CHAT_ID;

    // Служебная команда: узнать chat_id текущего чата (для настройки группы поддержки)
    if (msg.text && msg.text.trim() === '/chatid') {
      await tgSend(TG_TOKEN, chatId, 'chat_id этого чата: ' + chatId);
      return;
    }

    // Ответ оператора из группы поддержки → пересылаем клиенту
    if (SUPPORT_CHAT_ID && String(chatId) === String(SUPPORT_CHAT_ID) && msg.reply_to_message) {
      const quoted = msg.reply_to_message.text || '';
      const m = quoted.match(/#from:(\d+)/);
      if (m && msg.text) {
        await tgSend(TG_TOKEN, m[1], '💬 Поддержка Компас:\n\n' + msg.text);
        await tgSend(TG_TOKEN, chatId, '✅ Отправлено клиенту');
      }
      return;
    }

    if (msg.text && msg.text.startsWith('/start')) {
      const parts = msg.text.split(' ');
      const sessionId = parts[1] || '';
      const s = tgSessions.get(sessionId);
      if (s) s.chatId = chatId;
      await tgSend(TG_TOKEN, chatId,
        'Здравствуйте! Для входа в Компас.Доставка подтвердите свой номер телефона.\n\nНажмите кнопку ниже 👇',
        {
          keyboard: [[{ text: '📱 Поделиться контактом', request_contact: true }]],
          resize_keyboard: true, one_time_keyboard: true
        });
      return;
    }

    if (msg.contact && msg.contact.phone_number) {
      const tgPhone = msg.contact.phone_number.replace(/\D/g, '');
      let matched = null;
      for (const [sid, s] of tgSessions.entries()) {
        if (s.chatId === chatId && s.status === 'pending') { matched = { sid, s }; break; }
      }
      if (!matched) {
        await tgSend(TG_TOKEN, chatId, 'Сессия не найдена. Вернитесь в приложение и начните заново.');
        return;
      }
      if (tgPhone.slice(-10) === matched.s.phone.slice(-10)) {
        matched.s.status = 'confirmed';
        matched.s.tgPhone = tgPhone;
        await tgSend(TG_TOKEN, chatId, '✅ Номер подтверждён! Вход выполнен.\n\nМожете вернуться обратно в приложение. Приятных вам покупок! 🛒', { remove_keyboard: true });
      } else {
        await tgSend(TG_TOKEN, chatId,
          '❌ Номер не совпадает с тем, что вы ввели в приложении.\n\nВы ввели: +' + matched.s.phone +
          '\nВ Telegram: +' + tgPhone + '\n\nПроверьте номер в приложении.', { remove_keyboard: true });
      }
      return;
    }

    // Обычное текстовое сообщение в личке боту = обращение в поддержку
    if (msg.text && msg.chat && msg.chat.type === 'private') {
      if (!SUPPORT_CHAT_ID) return;          // группа поддержки не настроена
      const u = msg.from || {};
      const who = ([u.first_name, u.last_name].filter(Boolean).join(' ') || 'Клиент') +
        (u.username ? ' (@' + u.username + ')' : '');
      await tgSend(TG_TOKEN, SUPPORT_CHAT_ID,
        '📨 Обращение в поддержку\nОт: ' + who + '\n\n' + msg.text +
        '\n\n↩️ Ответьте на это сообщение, чтобы написать клиенту\n#from:' + chatId);
      await tgSend(TG_TOKEN, chatId, '✅ Ваше сообщение получено, оператор скоро ответит.');
      return;
    }
  } catch(e) {
    console.error('TG update error:', e.message);
  }
}

// Запускаем цикл polling
setInterval(tgPoll, 1000);

// Отправка сообщения в Telegram
async function tgSend(token, chatId, text, replyMarkup) {
  try {
    await fetch('https://api.telegram.org/bot' + token + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: chatId, text, reply_markup: replyMarkup || undefined })
    });
  } catch(e) { console.error('tgSend:', e.message); }
}


// ── TELEGRAM-УВЕДОМЛЕНИЯ О СТАТУСЕ ЗАКАЗА ──
const MS_API = 'https://api.moysklad.ru/api/remap/1.2';
function msAuthHeaders(json) {
  const h = { 'Authorization': 'Bearer ' + process.env.MS_TOKEN };
  if (json) h['Content-Type'] = 'application/json';
  return h;
}

// meta доп.поля «Telegram chatId» у контрагента — ищем по имени, ID не хардкодим
let _tgAttrMeta = null;
async function getTgChatAttrMeta() {
  if (_tgAttrMeta) return _tgAttrMeta;
  try {
    const r = await fetch(MS_API + '/entity/counterparty/metadata/attributes', { headers: msAuthHeaders() });
    const data = await r.json();
    const attr = (data.rows || []).find(a => a.name === 'Telegram chatId');
    if (attr) _tgAttrMeta = attr.meta;
    else console.warn('Доп.поле «Telegram chatId» не найдено в МоёмСкладе');
  } catch(e) { console.error('getTgChatAttrMeta:', e.message); }
  return _tgAttrMeta;
}

// Приложение вызывает после входа — сохраняем chatId в контрагента
app.post('/tg/link', async (req, res) => {
  try {
    const clientId = req.body.clientId;
    const chatId   = req.body.chatId;
    if (!clientId || !chatId) return res.status(400).json({ error: 'clientId и chatId обязательны' });
    const meta = await getTgChatAttrMeta();
    if (!meta) return res.status(500).json({ error: 'attr_not_found' });
    const r = await fetch(MS_API + '/entity/counterparty/' + clientId, {
      method: 'PUT', headers: msAuthHeaders(true),
      body: JSON.stringify({ attributes: [{ meta, value: String(chatId) }] })
    });
    if (!r.ok) {
      const t = await r.text();
      console.warn('tg/link MS error', r.status, t.slice(0, 200));
      return res.status(502).json({ error: 'moysklad_' + r.status });
    }
    console.log('TG link: client', clientId, '→ chat', chatId);
    res.json({ ok: true });
  } catch(e) { res.status(500).json({ error: e.message }); }
});

// chatId из контрагента (по его attributes)
function chatIdFromAgent(agent) {
  if (!agent || !agent.attributes) return null;
  const a = agent.attributes.find(x => x.name === 'Telegram chatId');
  return a && a.value ? String(a.value) : null;
}
async function getChatIdForOrder(o) {
  let chatId = chatIdFromAgent(o.agent);          // из expand=agent
  if (chatId) return chatId;
  const href = o.agent && o.agent.meta && o.agent.meta.href;
  if (!href) return null;
  try {                                            // fallback — подтягиваем контрагента целиком
    const r = await fetch(href, { headers: msAuthHeaders() });
    return chatIdFromAgent(await r.json());
  } catch(e) { return null; }
}

// Стадия по названию статуса — та же логика, что в приложении
function stageFromStateName(name) {
  const s = (name || '').toLowerCase();
  if (s.includes('отмен')) return 0;
  if (s.includes('возврат')) return 6;
  if (s.includes('доставлен') || s.includes('выполнен') || s.includes('завершён')) return 4;
  if (s.includes('пути') || s.includes('доставка') || s.includes('курьер')) return 3;
  if (s.includes('сбор')) return 2;
  if (s.includes('подтвердить оплату')) return 5;  // внутренняя стадия — не уведомляем
  if (s.includes('принят') || s.includes('новый')) return 1;
  return -1;
}

const ORDER_MSG = {
  1: num => `✅ Ваш заказ ${num} принят! Мы скоро начнём его собирать.`,
  2: num => `🛒 Заказ ${num} собирается на складе.`,
  // 3 (В пути) НЕ шлём из наблюдателя — уведомление с контактами курьера уходит при принятии заказа (/order/accept)
  4: num => `✓ Заказ ${num} доставлен. Спасибо, что выбрали Компас.Доставку! 💚`,
  0: num => `❌ Заказ ${num} отменён. Если это ошибка — напишите нам.`,
  6: num => `↩️ По заказу ${num} оформлен возврат.`,
};

// Следим за сменой статуса активных заказов и шлём уведомление в Telegram
const orderStageSeen = new Map(); // orderId → последняя замеченная стадия
let orderWatchBaseline = false;   // первый прогон — базовая линия (без рассылки)
// Push сборщикам о новых заказах: помним, о каких уже уведомили
const ST_ACCEPTED = '6b9511c9-02a8-11ed-0a80-073c00232c39';
const pickerNotified = new Set();
let _lastWatch = { at: null, rows: 0, changed: 0, sent: 0, error: null };
async function watchOrderStatuses() {
  if (!process.env.MS_TOKEN) return;
  if (!process.env.TG_BOT_TOKEN && !pushEnabled()) return; // ни одного канала уведомлений
  try {
    const r = await fetch(MS_API + '/entity/customerorder?limit=100&order=updated,desc&expand=state,agent', { headers: msAuthHeaders() });
    const data = await r.json();
    const rows = data.rows || [];
    let changed = 0, sent = 0;
    const pendingNow = []; // для /sborka/pending (нативная служба APK)
    for (const o of rows) {
      const stage = stageFromStateName(o.state && o.state.name);
      const prev  = orderStageSeen.get(o.id);
      orderStageSeen.set(o.id, stage);

      // Push на ТСД сборщиков: заказ впервые стал видимым для сборки
      // (наличные — сразу «Новый»; онлайн — только после оплаты, статус «Оплачен онлайн»)
      const stId = o.state && o.state.id;
      const pickerVisible = stId === ST_ACCEPTED || stId === ST_AUTHORIZED ||
        (stId === ST_NEW && (o.description || '').indexOf('Картой онлайн') === -1);
      if (pickerVisible) pendingNow.push({ id: o.id, name: o.name || '' });
      if (pickerVisible && !pickerNotified.has(o.id)) {
        pickerNotified.add(o.id);
        if (pickerNotified.size > 2000) pickerNotified.clear(); // страховка от роста памяти
        if (orderWatchBaseline) {
          const pn = await sendPushToClient('sborka-pickers', '🔔 Компас.Сборка',
            'Новый заказ ' + (o.name || '') + ' на сборку');
          if (pn) console.log('PUSH sborka: новый заказ', o.name, '×' + pn);
        }
      }

      if (!orderWatchBaseline) continue;                  // первый прогон — только запоминаем
      if (prev === undefined || prev === stage) continue; // нет смены статуса
      changed++;
      const make = ORDER_MSG[stage];
      if (!make) continue;                                // эту стадию не уведомляем
      const text = make(o.name || '');
      if (process.env.TG_BOT_TOKEN) {
        const chatId = await getChatIdForOrder(o);
        if (chatId) {
          await tgSend(process.env.TG_BOT_TOKEN, chatId, text);
          sent++;
          console.log('TG notify:', o.name, '→ stage', stage, 'chat', chatId);
        }
      }
      const pushed = await sendPushToClient(agentIdFromOrder(o), 'Компас.Доставка', text);
      if (pushed) { sent += pushed; console.log('PUSH notify:', o.name, '→ stage', stage, '×' + pushed); }
    }
    orderWatchBaseline = true;
    pickerPendingCache = { at: Date.now(), orders: pendingNow };
    _lastWatch = { at: new Date().toISOString(), rows: rows.length, changed, sent, error: rows.length ? null : 'no rows' };
  } catch(e) {
    _lastWatch = { at: new Date().toISOString(), rows: 0, changed: 0, sent: 0, error: e.message };
    console.error('watchOrderStatuses:', e.message);
  }
}
setInterval(watchOrderStatuses, 30000);

// ── СТОРОЖ БРОШЕННЫХ ОПЛАТ ──
// Заказ создаётся в МС до оплаты (иначе при сбое возврата из банка были бы «деньги без заказа»).
// Если клиент ушёл со страницы оплаты и не вернулся, приложение его не отменит — делаем это здесь:
// «Новый» + «Картой онлайн» → оплачен у банка = ставим «Оплачен онлайн»; не оплачен за 25 мин = отменяем.
const ST_NEW        = '6b950fea-02a8-11ed-0a80-073c00232c38';
const ST_AUTHORIZED = 'beee8bc0-5a0d-11f1-0a80-1ae90004ebf1';
const ST_PAID       = 'bef10ed6-5a0d-11f1-0a80-1ae90004ebf4';
async function msSetOrderState(orderId, stateId) {
  const r = await fetch(MS_API + '/entity/customerorder/' + orderId, {
    method: 'PUT', headers: msAuthHeaders(true),
    body: JSON.stringify({ state: { meta: {
      href: MS_API + '/entity/customerorder/metadata/states/' + stateId,
      type: 'state', mediaType: 'application/json'
    } } })
  });
  if (!r.ok) console.warn('msSetOrderState', orderId, '→', stateId, 'HTTP', r.status);
  return r.ok;
}
let _abandonedBusy = false;
async function reconcileAbandonedPayments() {
  if (_abandonedBusy || !process.env.MS_TOKEN) return;
  let creds; try { creds = alfaCredentials(); } catch(e) { return; }
  _abandonedBusy = true;
  try {
    const r = await fetch(MS_API + '/entity/customerorder?limit=50&order=created,desc&expand=state', { headers: msAuthHeaders() });
    const rows = (await r.json()).rows || [];
    const now = Date.now();
    for (const o of rows) {
      if (!o.state || o.state.id !== ST_NEW) continue;                       // только «Новый»
      if ((o.description || '').indexOf('Картой онлайн') === -1) continue;  // наличные не трогаем
      const attr = (o.attributes || []).find(a => a.name === 'Alfa orderId');
      const alfaOrderId = attr && attr.value;
      if (!alfaOrderId) continue;                                            // платёж не привязан — не рискуем
      const created = Date.parse((o.created || '').replace(' ', 'T') + '+03:00'); // время МС — московское
      const ageMin = created ? (now - created) / 60000 : 0;
      if (ageMin < 2) continue;                                              // даём оплате завершиться
      const stRes = await fetch(ALFA_API + '/getOrderStatusExtended.do', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
        body: new URLSearchParams({ orderId: alfaOrderId, ...creds }).toString()
      });
      const st = await stRes.json();
      const os = st.orderStatus ?? st.OrderStatus;
      if (os === 1 || os === 2) {
        // оплачен, но клиент не вернулся в приложение — отмечаем оплату сами
        await msSetOrderState(o.id, os === 2 ? ST_PAID : ST_AUTHORIZED);
        console.log('ABANDONED paid:', o.name, '→', os === 2 ? 'PAID' : 'AUTHORIZED');
      } else if (ageMin >= 25 && (os === 0 || os === 3 || os === 6)) {
        // сессия оплаты (20 мин) истекла, платежа нет — заказ не состоялся
        await msSetOrderState(o.id, CANCELLED_STATE);
        console.log('ABANDONED cancel:', o.name, 'alfa status', os);
      }
    }
  } catch(e) {
    console.warn('reconcileAbandonedPayments:', e.message);
  } finally { _abandonedBusy = false; }
}
setInterval(reconcileAbandonedPayments, 60000);

// Диагностика уведомлений: состояние наблюдателя + тест отправки (?send=<chatId>)
app.get('/tg/debug', async (req, res) => {
  var sborka = getSborkaUsers();
  const out = {
    baseline: orderWatchBaseline,
    trackedOrders: orderStageSeen.size,
    attrFound: !!_tgAttrMeta,
    hasBotToken: !!process.env.TG_BOT_TOKEN,
    sborkaUsersCount: Object.keys(sborka).length,        // сколько сборщиков реально загружено
    sborkaPinLengths: Object.keys(sborka).map(p => p.length), // длины PIN (5 = кавычка попала в значение)
    sborkaEnvKeys: Object.keys(process.env).filter(k => k.toUpperCase().indexOf('SBORKA') === 0), // имена SBORKA*-переменных (без значений)
    lastWatch: _lastWatch
  };
  res.json(out);
});


// ── ВХОД СБОРЩИКОВ ПО PIN ──
// Сборщики хранятся в env SBORKA_USERS в формате: PIN:Имя,PIN:Имя
// Пример: 1234:Иван Петров,5678:Мария Сидорова
// Разбор пользователей из env: одна переменная со списком через запятую ИЛИ
// отдельные переменные с префиксом (SBORKA_USER1, COURIER_USER1, ...). Формат PIN:Имя.
function parseUsersFrom(singleEnv, prefix) {
  const users = {};
  function addPair(raw) {
    const [pin, ...nameParts] = (raw || '').split(':');
    if (pin && pin.trim() && nameParts.length) users[pin.trim()] = nameParts.join(':').trim();
  }
  (process.env[singleEnv] || '').split(',').forEach(addPair);
  Object.keys(process.env).forEach(function(key) {
    if (key.indexOf(prefix) === 0 && key !== singleEnv) addPair(process.env[key]);
  });
  return users;
}
function getSborkaUsers()  { return parseUsersFrom('SBORKA_USERS',  'SBORKA_USER');  }
function getCourierUsers() { return parseUsersFrom('COURIER_USERS', 'COURIER_USER'); }

app.post('/sborka/login', (req, res) => {
  const pin = (req.body.pin || '').trim();
  const pickers = getSborkaUsers();
  if (pickers[pin]) return res.json({ ok: true, name: pickers[pin], pin, role: 'picker' });
  const couriers = getCourierUsers();
  if (couriers[pin]) return res.json({ ok: true, name: couriers[pin], pin, role: 'courier' });
  res.status(401).json({ error: 'Неверный PIN-код' });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Kompas Proxy running on port ' + PORT));

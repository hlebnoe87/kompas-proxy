const express = require('express');
const fetch   = require('node-fetch');
const app     = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Health-check для Amvera: корень должен отдавать 200 (раньше был 404 → проба не проходила)
app.get('/', (req, res) => res.json({ ok: true, service: 'kompas-proxy' }));

// ── Безопасность: CORS только с разрешённых доменов ──
const ALLOWED_ORIGINS = ['https://kompas87.ru', 'https://www.kompas87.ru'];
app.use((req, res, next) => {
  const origin = req.headers.origin || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
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

// Credentials только из переменных окружения — не из кода
function alfaCredentials() {
  const user = process.env.ALFA_USER;
  const pass = process.env.ALFA_PASS;
  if (!user || !pass) throw new Error('Alfa-Bank credentials not configured');
  return { userName: user, password: pass };
}

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
    const response = await fetch('https://alfa.rbsuat.com/payment/rest/registerPreAuth.do', {
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

// ── Альфа-Банк: ОТМЕНА ХОЛДА (заказ отменён до списания) ──
app.post('/payment/reverse.do', async (req, res) => {
  try {
    const creds = alfaCredentials();
    const params = new URLSearchParams({ ...req.body, ...creds });
    console.log('REVERSE:', req.body.orderId);
    const response = await fetch('https://alfa.rbsuat.com/payment/rest/reverse.do', {
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
    // 1. находим alfaOrderId в заказе
    const oRes = await fetch(MS_API + '/entity/customerorder/' + msOrderId, { headers: msAuthHeaders() });
    const order = await oRes.json();
    const attr = (order.attributes || []).find(a => a.name === 'Alfa orderId');
    const alfaOrderId = attr && attr.value;
    if (!alfaOrderId) return res.json({ ok: false, reason: 'no_online_payment' }); // наличные — нечего списывать
    // 2. узнаём удержанную сумму и статус
    const stParams = new URLSearchParams({ orderId: alfaOrderId, ...creds });
    const stRes = await fetch('https://alfa.rbsuat.com/payment/rest/getOrderStatusExtended.do', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: stParams.toString()
    });
    const st = await stRes.json();
    const os = st.orderStatus ?? st.OrderStatus;          // устойчиво к регистру поля
    const amount = parseInt(st.amount ?? st.Amount ?? 0);
    if (os === 2) return res.json({ ok: true, already: true });   // уже списан (идемпотентность)
    if (os !== 1 || !amount) return res.json({ ok: false, reason: 'not_held', status: st });
    // 3. списываем полную удержанную сумму
    const depParams = new URLSearchParams({ orderId: alfaOrderId, amount: String(amount), ...creds });
    const depRes = await fetch('https://alfa.rbsuat.com/payment/rest/deposit.do', {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: depParams.toString()
    });
    const dep = await depRes.json();
    const okDep = !dep.errorCode || dep.errorCode === '0';
    console.log('CAPTURE order', msOrderId, 'amount', amount, okDep ? 'OK' : dep.errorMessage);
    res.json({ ok: okDep, amount, deposit: dep });
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
      const stRes = await fetch('https://alfa.rbsuat.com/payment/rest/getOrderStatusExtended.do', {
        method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: stParams.toString()
      });
      const st = await stRes.json();
      const os = st.orderStatus ?? st.OrderStatus;
      const amount = parseInt(st.amount ?? st.Amount ?? 0);
      if (os === 1) {                                   // холд не списан → снимаем
        const p = new URLSearchParams({ orderId: alfaOrderId, ...creds });
        const r = await fetch('https://alfa.rbsuat.com/payment/rest/reverse.do', {
          method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: p.toString()
        });
        payment = { action: 'reverse', result: await r.json() };
      } else if (os === 2) {                            // уже списан → полный возврат
        const p = new URLSearchParams({ orderId: alfaOrderId, amount: String(amount), ...creds });
        const r = await fetch('https://alfa.rbsuat.com/payment/rest/refund.do', {
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
    // Telegram клиенту: «В пути» с контактами курьера
    const chatId = await getChatIdForOrder(order);
    if (chatId && process.env.TG_BOT_TOKEN) {
      await tgSend(process.env.TG_BOT_TOKEN, chatId,
        '🛵 Заказ ' + (order.name || '') + ' уже в пути!\nКурьер: ' + courierName + '\nТелефон: ' + courierPhone);
    }
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


// ── SMS верификация через SMSC.ru ──
const crypto = require('crypto');
const smsTokens = new Map(); // phone → { code, expires }

// Отправка SMS с кодом
app.post('/sms/send', async (req, res) => {
  const phone = (req.body.phone || '').replace(/\D/g, '');
  if (!phone || phone.length < 10) {
    return res.status(400).json({ error: 'Неверный номер телефона' });
  }

  // Генерируем 4-значный код
  const code = String(Math.floor(1000 + Math.random() * 9000));
  const expires = Date.now() + 5 * 60 * 1000; // 5 минут
  smsTokens.set(phone, { code, expires, attempts: 0 });

  const login    = process.env.SMSC_LOGIN    || '';
  const password = process.env.SMSC_PASSWORD || '';
  const message  = encodeURIComponent(`Компас.Доставка: код входа ${code}. Никому не сообщайте.`);
  const smscUrl  = `https://smsc.ru/sys/send.php?login=${login}&psw=${password}&phones=${phone}&mes=${message}&fmt=3&charset=utf-8`;

  try {
    const r = await fetch(smscUrl, { signal: AbortSignal.timeout(10000) });
    const data = await r.json();
    console.log('SMS отправлено на', phone, ':', data);
    if (data.error_code) {
      return res.status(500).json({ error: 'Ошибка отправки SMS: ' + data.error });
    }
    res.json({ ok: true, phone });
  } catch(e) {
    console.error('SMSC error:', e.message);
    res.status(500).json({ error: 'Не удалось отправить SMS' });
  }
});

// Проверка кода
app.post('/sms/verify', async (req, res) => {
  const phone = (req.body.phone || '').replace(/\D/g, '');
  const code  = (req.body.code  || '').trim();

  const entry = smsTokens.get(phone);
  if (!entry) {
    return res.status(400).json({ error: 'Код не найден. Запросите новый.' });
  }
  if (Date.now() > entry.expires) {
    smsTokens.delete(phone);
    return res.status(400).json({ error: 'Код истёк. Запросите новый.' });
  }
  entry.attempts = (entry.attempts || 0) + 1;
  if (entry.attempts > 5) {
    smsTokens.delete(phone);
    return res.status(429).json({ error: 'Слишком много попыток. Запросите новый код.' });
  }
  if (entry.code !== code) {
    return res.status(400).json({ error: 'Неверный код. Попробуйте ещё раз.' });
  }

  // Код верный — удаляем
  smsTokens.delete(phone);
  res.json({ ok: true, phone });
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
        await tgSend(TG_TOKEN, chatId, '✅ Номер подтверждён! Вернитесь в приложение — вход выполнен.', { remove_keyboard: true });
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
let _lastWatch = { at: null, rows: 0, changed: 0, sent: 0, error: null };
async function watchOrderStatuses() {
  if (!process.env.TG_BOT_TOKEN || !process.env.MS_TOKEN) return;
  try {
    const r = await fetch(MS_API + '/entity/customerorder?limit=100&order=updated,desc&expand=state,agent', { headers: msAuthHeaders() });
    const data = await r.json();
    const rows = data.rows || [];
    let changed = 0, sent = 0;
    for (const o of rows) {
      const stage = stageFromStateName(o.state && o.state.name);
      const prev  = orderStageSeen.get(o.id);
      orderStageSeen.set(o.id, stage);
      if (!orderWatchBaseline) continue;                  // первый прогон — только запоминаем
      if (prev === undefined || prev === stage) continue; // нет смены статуса
      changed++;
      const make = ORDER_MSG[stage];
      if (!make) continue;                                // эту стадию не уведомляем
      const chatId = await getChatIdForOrder(o);
      if (!chatId) continue;                              // у клиента нет привязанного Telegram
      await tgSend(process.env.TG_BOT_TOKEN, chatId, make(o.name || ''));
      sent++;
      console.log('TG notify:', o.name, '→ stage', stage, 'chat', chatId);
    }
    orderWatchBaseline = true;
    _lastWatch = { at: new Date().toISOString(), rows: rows.length, changed, sent, error: rows.length ? null : 'no rows' };
  } catch(e) {
    _lastWatch = { at: new Date().toISOString(), rows: 0, changed: 0, sent: 0, error: e.message };
    console.error('watchOrderStatuses:', e.message);
  }
}
setInterval(watchOrderStatuses, 30000);

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

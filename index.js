const express = require('express');
const fetch   = require('node-fetch');
const app     = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

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
  res.json({ status: s.status, phone: s.phone });
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

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Kompas Proxy running on port ' + PORT));

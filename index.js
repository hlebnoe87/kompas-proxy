const express = require('express');
const fetch   = require('node-fetch');
const app     = express();

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin',  '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// ── МойСклад API ──
app.all('/proxy/*', async (req, res) => {
  const path  = req.path.replace('/proxy', '');
  const query = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
  const msUrl = 'https://api.moysklad.ru/api/remap/1.2' + path + query;
  try {
    const headers = { 'Authorization': 'Bearer ' + process.env.MS_TOKEN };
    if (req.method === 'POST' || req.method === 'PUT') {
      headers['Content-Type'] = 'application/json';
    }
    const options = { method: req.method, headers };
    if ((req.method === 'POST' || req.method === 'PUT') && req.body) {
      options.body = JSON.stringify(req.body);
    }
    console.log(req.method, msUrl);
    const response = await fetch(msUrl, options);
    const text     = await response.text();
    res.status(response.status).header('Content-Type', 'application/json').send(text);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// ── Проверка статуса платежа Альфа-Банк ──
app.post('/payment/getOrderStatus.do', async (req, res) => {
  const alfaUrl = 'https://alfa.rbsuat.com/payment/rest/getOrderStatus.do';
  const params = new URLSearchParams({
    ...req.body,
    userName: process.env.ALFA_USER || 'r-kompas87-api',
    password: process.env.ALFA_PASS || 'kompas87*?1',
  });
  try {
    const response = await fetch(alfaUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const data = await response.json();
    console.log('STATUS RESPONSE:', JSON.stringify(data));
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Альфа-Банк Эквайринг ──
app.post('/payment/*', async (req, res) => {
  const path    = req.path.replace('/payment', '');
  const alfaUrl = 'https://alfa.rbsuat.com/payment/rest' + path;

  const params = new URLSearchParams({
    ...req.body,
    userName: process.env.ALFA_USER || 'r-kompas87-api',
    password: process.env.ALFA_PASS || 'kompas87*?1',
  });

  console.log('PAYMENT URL:', alfaUrl);
  console.log('PAYMENT PARAMS:', params.toString());

  try {
    const response = await fetch(alfaUrl, {
      method:  'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body:    params.toString()
    });
    const data = await response.json();
    console.log('PAYMENT RESPONSE:', JSON.stringify(data));
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});


// ── Подтверждение списания (deposit) ──
app.post('/payment/deposit.do', async (req, res) => {
  const alfaUrl = 'https://alfa.rbsuat.com/payment/rest/deposit.do';
  const params = new URLSearchParams({
    ...req.body,
    userName: process.env.ALFA_USER || 'r-kompas87-api',
    password: process.env.ALFA_PASS || 'kompas87*?1',
  });
  try {
    console.log('DEPOSIT:', req.body.orderId, 'amount:', req.body.amount);
    const response = await fetch(alfaUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: params.toString()
    });
    const data = await response.json();
    console.log('DEPOSIT RESPONSE:', JSON.stringify(data));
    res.json(data);
  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

// ── Вебхук от МоегоСклада — смена статуса заказа ──
app.post('/webhook/moysklad', async (req, res) => {
  res.sendStatus(200); // отвечаем сразу
  try {
    const events = req.body && req.body.events || [];
    for (const event of events) {
      if (event.meta && event.meta.type === 'customerorder' && event.action === 'UPDATE') {
        const orderHref = event.meta.href;
        // Получаем заказ из МоегоСклада
        const orderRes = await fetch(orderHref + '?expand=state', {
          headers: { 'Authorization': 'Bearer ' + process.env.MS_TOKEN }
        });
        const order = await orderRes.json();
        const stateId = order.state && order.state.id;
        const CONFIRM_PAY_STATE = 'c97e6308-5f8e-11f1-0a80-10ed00018c22';
        const PAID_STATE        = 'bef10ed6-5a0d-11f1-0a80-1ae90004ebf4';
        if (stateId === CONFIRM_PAY_STATE) {
          // Ищем alfaOrderId в атрибутах заказа
          const alfaOrderId = order.attributes && order.attributes.find(a => a.name === 'alfaOrderId');
          if (alfaOrderId && alfaOrderId.value) {
            // Подтверждаем списание
            const params = new URLSearchParams({
              orderId:  alfaOrderId.value,
              amount:   Math.round((order.sum || 0)),
              userName: process.env.ALFA_USER || 'r-kompas87-api',
              password: process.env.ALFA_PASS || 'kompas87*?1',
            });
            const depRes = await fetch('https://alfa.rbsuat.com/payment/rest/deposit.do', {
              method: 'POST',
              headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
              body: params.toString()
            });
            const depData = await depRes.json();
            console.log('WEBHOOK DEPOSIT:', JSON.stringify(depData));
            if (!depData.errorCode || depData.errorCode === '0') {
              // Меняем статус на «Оплачен»
              await fetch(orderHref, {
                method: 'PUT',
                headers: { 'Authorization': 'Bearer ' + process.env.MS_TOKEN, 'Content-Type': 'application/json' },
                body: JSON.stringify({ state: { meta: { href: 'https://api.moysklad.ru/api/remap/1.2/entity/customerorder/metadata/states/' + PAID_STATE, type: 'state', mediaType: 'application/json' } } })
              });
              console.log('WEBHOOK: заказ переведён в Оплачен');
            }
          }
        }
      }
    }
  } catch(e) {
    console.error('WEBHOOK ERROR:', e.message);
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Kompas Proxy running on port ' + PORT));

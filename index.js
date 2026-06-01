const express = require('express');
const fetch   = require('node-fetch');
const app     = express();

app.use(express.json());

// CORS
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin',  '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Проксируем все запросы /proxy/* → МойСклад API
app.all('/proxy/*', async (req, res) => {
  // Убираем префикс /proxy
  const path  = req.path.replace('/proxy', '');
  const query = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';

  // Поддерживаем оба базовых пути МоегоСклада
  // /retail/* → https://api.moysklad.ru/api/retail/1.0
  // всё остальное → https://api.moysklad.ru/api/remap/1.2
  let msBase;
  if (path.startsWith('/retail/')) {
    msBase = 'https://api.moysklad.ru/api/retail/1.0';
  } else {
    msBase = 'https://api.moysklad.ru/api/remap/1.2';
  }

  const msUrl = msBase + path + query;

  try {
    const headers = {
      'Authorization': 'Bearer ' + process.env.MS_TOKEN,
    };

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

    res.status(response.status)
       .header('Content-Type', 'application/json')
       .send(text);

  } catch(e) {
    console.error('Proxy error:', e.message);
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Kompas Proxy running on port ' + PORT));

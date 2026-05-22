const express = require('express');
const fetch = require('node-fetch');
const app = express();

app.use(express.json());

// CORS для всех запросов
app.use((req, res, next) => {
  res.header('Access-Control-Allow-Origin', '*');
  res.header('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.header('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  if (req.method === 'OPTIONS') return res.sendStatus(204);
  next();
});

// Прокси всех методов к МоемуСкладу
app.all('/proxy/*', async (req, res) => {
  const path = req.path.replace('/proxy', '');
  const query = req.url.includes('?') ? req.url.substring(req.url.indexOf('?')) : '';
  const msUrl = 'https://api.moysklad.ru/api/remap/1.2' + path + query;

  try {
    const options = {
      method: req.method,
      headers: {
        'Authorization': 'Bearer ' + process.env.MS_TOKEN,
        'Content-Type': 'application/json',
        'Accept-Encoding': 'identity'
      }
    };

    // Добавляем тело только для POST и PUT
    if ((req.method === 'POST' || req.method === 'PUT') && req.body) {
      options.body = JSON.stringify(req.body);
    }

    const response = await fetch(msUrl, options);
    const text = await response.text();

    res.status(response.status)
       .header('Content-Type', 'application/json')
       .send(text);

  } catch(e) {
    res.status(500).json({ error: e.message });
  }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Proxy running on port ' + PORT));

const express = require('express');
const https = require('https');
const path = require('path');

const app = express();
app.use(express.json({ limit: '10mb' }));
app.use(express.static(path.join(__dirname)));

app.get('/api/health', (req, res) => {
  res.json({ ok: true, keySet: !!process.env.ANTHROPIC_API_KEY });
});

app.post('/api/chat', (req, res) => {
  const apiKey = process.env.ANTHROPIC_API_KEY;
  if (!apiKey) {
    return res.status(500).json({ error: { message: 'API key not configured on server.' } });
  }

  const body = JSON.stringify(req.body);
  const isStream = req.body.stream === true;

  const options = {
    hostname: 'api.anthropic.com',
    path: '/v1/messages',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-api-key': apiKey,
      'anthropic-version': '2023-06-01',
      'Content-Length': Buffer.byteLength(body)
    }
  };

  const apiReq = https.request(options, (apiRes) => {
    res.status(apiRes.statusCode);

    // Always buffer error responses as JSON so the browser can read them
    if (apiRes.statusCode !== 200) {
      let data = '';
      apiRes.on('data', chunk => { data += chunk; });
      apiRes.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.send(data);
      });
      return;
    }

    if (isStream) {
      res.setHeader('Content-Type', 'text/event-stream');
      apiRes.pipe(res);
    } else {
      let data = '';
      apiRes.on('data', chunk => { data += chunk; });
      apiRes.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.send(data);
      });
    }
  });

  apiReq.on('error', (err) => {
    res.status(500).json({ error: { message: err.message } });
  });

  apiReq.write(body);
  apiReq.end();
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Server on port ${PORT}`));

const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');

// Load env
const envFile = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '';
envFile.split('\n').forEach(line => {
  const m = line.match(/^([^=]+)="?([^"]*)"?$/);
  if (m) process.env[m[1].trim()] = m[2].trim();
});

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const PUBLIC_KEY = process.env.MP_PUBLIC_KEY;
const PORT = process.env.PORT || 8899;

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.webp': 'image/webp'
};

function serveStatic(req, res) {
  let filePath = path.join(__dirname, req.url === '/' ? 'index.html' : req.url);
  if (!fs.existsSync(filePath)) filePath = path.join(__dirname, 'index.html');
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

function mpRequest(method, endpoint, body, cb) {
  const data = body ? JSON.stringify(body) : null;
  const options = {
    hostname: 'api.mercadopago.com',
    path: endpoint,
    method,
    headers: {
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': Date.now().toString()
    }
  };
  if (data) options.headers['Content-Length'] = Buffer.byteLength(data);

  const req = https.request(options, r => {
    let raw = '';
    r.on('data', c => raw += c);
    r.on('end', () => {
      try { cb(null, JSON.parse(raw), r.statusCode); }
      catch(e) { cb(e); }
    });
  });
  req.on('error', cb);
  if (data) req.write(data);
  req.end();
}

function readBody(req, cb) {
  let body = '';
  req.on('data', c => body += c);
  req.on('end', () => { try { cb(null, JSON.parse(body)); } catch(e) { cb(e); } });
}

const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // API: criar preferência MP (checkout pro / redirect)
  if (pathname === '/api/mp/preference' && req.method === 'POST') {
    readBody(req, (err, body) => {
      if (err) { res.writeHead(400); res.end(JSON.stringify({error:'bad json'})); return; }

      const items = (body.items || []).map(i => ({
        title: i.title,
        quantity: i.quantity || 1,
        unit_price: parseFloat(i.unit_price),
        currency_id: 'BRL'
      }));

      const payload = {
        items,
        payer: body.payer || {},
        payment_methods: { excluded_payment_types: [], installments: 12 },
        back_urls: {
          success: body.back_url || 'https://powerpy.com/sucesso',
          failure: body.back_url || 'https://powerpy.com/erro',
          pending: body.back_url || 'https://powerpy.com/pendente'
        },
        auto_return: 'approved',
        statement_descriptor: 'POWERPY'
      };

      mpRequest('POST', '/checkout/preferences', payload, (err, data, status) => {
        if (err) { res.writeHead(500); res.end(JSON.stringify({error: err.message})); return; }
        res.writeHead(status, {'Content-Type':'application/json'});
        res.end(JSON.stringify(data));
      });
    });
    return;
  }

  // API: criar pagamento Pix
  if (pathname === '/api/mp/pix' && req.method === 'POST') {
    readBody(req, (err, body) => {
      if (err) { res.writeHead(400); res.end(JSON.stringify({error:'bad json'})); return; }

      const payload = {
        transaction_amount: parseFloat(body.amount),
        description: body.description || 'Pedido PowerPy',
        payment_method_id: 'pix',
        payer: {
          email: body.email || 'cliente@powerpy.com',
          first_name: body.nome || 'Cliente',
          last_name: body.sobrenome || 'PowerPy',
          identification: { type: 'CPF', number: body.cpf || '00000000000' }
        }
      };

      mpRequest('POST', '/v1/payments', payload, (err, data, status) => {
        if (err) { res.writeHead(500); res.end(JSON.stringify({error: err.message})); return; }
        res.writeHead(status, {'Content-Type':'application/json'});
        res.end(JSON.stringify(data));
      });
    });
    return;
  }

  // API: pagamento cartão
  if (pathname === '/api/mp/payment' && req.method === 'POST') {
    readBody(req, (err, body) => {
      if (err) { res.writeHead(400); res.end(JSON.stringify({error:'bad json'})); return; }
      mpRequest('POST', '/v1/payments', body, (err, data, status) => {
        if (err) { res.writeHead(500); res.end(JSON.stringify({error: err.message})); return; }
        res.writeHead(status, {'Content-Type':'application/json'});
        res.end(JSON.stringify(data));
      });
    });
    return;
  }

  // API: public key
  if (pathname === '/api/mp/pubkey' && req.method === 'GET') {
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ public_key: PUBLIC_KEY }));
    return;
  }

  // Static files
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`PowerPy server running on port ${PORT}`);
});

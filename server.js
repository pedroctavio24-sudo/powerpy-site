// deploy: 20260708015835
const http = require('http');
const https = require('https');
const fs = require('fs');
const path = require('path');
const url = require('url');
const crypto = require('crypto');

// Load env
const envFile = fs.existsSync('.env') ? fs.readFileSync('.env', 'utf8') : '';
envFile.split('\n').forEach(line => {
  const m = line.match(/^([^=]+)="?([^"]*)"?$/);
  if (m) process.env[m[1].trim()] = m[2].trim();
});

const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const PUBLIC_KEY   = process.env.MP_PUBLIC_KEY;
const PORT         = process.env.PORT || 8899;
const GH_TOKEN     = process.env.GH_TOKEN;
const GH_REPO      = 'pedroctavio24-sudo/powerpy-site';
const GH_BRANCH    = 'main';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'pp2126';

// Allowed origins (CORS)
const ALLOWED_ORIGINS = [
  'https://powerpy-site-production.up.railway.app',
  'http://localhost:8899',
  'http://localhost:3000'
];

// ─── RATE LIMITER ────────────────────────────────────────────────────────────
// Per-IP sliding window
const rateLimits = new Map(); // ip -> { count, resetAt }
function rateLimit(ip, maxPerMinute) {
  const now = Date.now();
  let entry = rateLimits.get(ip);
  if (!entry || now > entry.resetAt) {
    entry = { count: 1, resetAt: now + 60_000 };
    rateLimits.set(ip, entry);
    return false; // OK
  }
  entry.count++;
  if (entry.count > maxPerMinute) return true; // BLOCKED
  return false;
}
// Clean stale entries every 5 min
setInterval(() => {
  const now = Date.now();
  for (const [k, v] of rateLimits) if (now > v.resetAt) rateLimits.delete(k);
}, 300_000);

// ─── PRODUCTS ────────────────────────────────────────────────────────────────
let productsCache = null;
const PRODUCTS_FILE = path.join(__dirname, 'products.json');
if (fs.existsSync(PRODUCTS_FILE)) {
  try { productsCache = JSON.parse(fs.readFileSync(PRODUCTS_FILE, 'utf8')); } catch(e) {}
}

// ─── LEADS STORE ─────────────────────────────────────────────────────────────
// In-memory + flush to GitHub every 5 min (persistent across deploys)
const leadsStore = [];
const LEADS_GH_PATH = 'leads.json'; // file in repo root

// Load from /tmp as fast cache on restart
const LEADS_TMP = path.join('/tmp', 'pp_leads.json');
if (fs.existsSync(LEADS_TMP)) {
  try {
    const saved = JSON.parse(fs.readFileSync(LEADS_TMP, 'utf8'));
    if (Array.isArray(saved)) leadsStore.push(...saved);
  } catch(e) {}
}

function saveLeadsTmp() {
  try { fs.writeFileSync(LEADS_TMP, JSON.stringify(leadsStore, null, 2)); } catch(e) {}
}

// Persist leads to GitHub (called after every new lead + every 5 min)
let lastLeadsSha = null;
function persistLeadsToGH(cb) {
  if (!GH_TOKEN) { if (cb) cb(new Error('no GH_TOKEN')); return; }
  const content = Buffer.from(JSON.stringify(leadsStore, null, 2)).toString('base64');
  const getPath = `/repos/${GH_REPO}/contents/${LEADS_GH_PATH}?ref=${GH_BRANCH}`;
  githubRequest('GET', getPath, null, (err, data) => {
    const sha = (!err && data && data.sha) ? data.sha : (lastLeadsSha || undefined);
    const payload = {
      message: `leads: auto-save ${new Date().toISOString()}`,
      content,
      branch: GH_BRANCH
    };
    if (sha) payload.sha = sha;
    githubRequest('PUT', `/repos/${GH_REPO}/contents/${LEADS_GH_PATH}`, payload, (err2, data2) => {
      if (!err2 && data2 && data2.content && data2.content.sha) lastLeadsSha = data2.content.sha;
      if (cb) cb(err2);
    });
  });
}

// Load leads from GitHub on startup
function loadLeadsFromGH() {
  if (!GH_TOKEN) return;
  githubRequest('GET', `/repos/${GH_REPO}/contents/${LEADS_GH_PATH}?ref=${GH_BRANCH}`, null, (err, data) => {
    if (err || !data || !data.content) return;
    try {
      const decoded = Buffer.from(data.content.replace(/\n/g, ''), 'base64').toString('utf8');
      const remote = JSON.parse(decoded);
      if (Array.isArray(remote) && remote.length > leadsStore.length) {
        leadsStore.length = 0;
        leadsStore.push(...remote);
        saveLeadsTmp();
        if (data.sha) lastLeadsSha = data.sha;
        console.log(`[leads] loaded ${leadsStore.length} from GitHub`);
      }
    } catch(e) { console.error('[leads] load error', e.message); }
  });
}
loadLeadsFromGH();

// Flush every 5 min
setInterval(() => {
  if (leadsStore.length > 0) persistLeadsToGH();
}, 300_000);

// ─── HELPERS ─────────────────────────────────────────────────────────────────
function githubRequest(method, endpoint, body, cb) {
  const data = body ? JSON.stringify(body) : null;
  const options = {
    hostname: 'api.github.com',
    path: endpoint,
    method,
    headers: {
      'Authorization': `token ${GH_TOKEN}`,
      'User-Agent': 'powerpy-server',
      'Content-Type': 'application/json',
      'Accept': 'application/vnd.github.v3+json'
    }
  };
  if (data) options.headers['Content-Length'] = Buffer.byteLength(data);
  const req = https.request(options, r => {
    let raw = '';
    r.on('data', c => raw += c);
    r.on('end', () => { try { cb(null, JSON.parse(raw), r.statusCode); } catch(e) { cb(e); } });
  });
  req.on('error', cb);
  if (data) req.write(data);
  req.end();
}

function mpRequest(method, endpoint, body, cb) {
  const data = body ? JSON.stringify(body) : null;
  const idempotencyKey = crypto.randomUUID();
  const options = {
    hostname: 'api.mercadopago.com',
    path: endpoint,
    method,
    headers: {
      'Authorization': `Bearer ${ACCESS_TOKEN}`,
      'Content-Type': 'application/json',
      'X-Idempotency-Key': idempotencyKey
    }
  };
  if (data) options.headers['Content-Length'] = Buffer.byteLength(data);
  const req = https.request(options, r => {
    let raw = '';
    r.on('data', c => raw += c);
    r.on('end', () => { try { cb(null, JSON.parse(raw), r.statusCode); } catch(e) { cb(e); } });
  });
  req.on('error', cb);
  if (data) req.write(data);
  req.end();
}

function readBody(req, cb) {
  let body = '';
  req.on('data', c => { body += c; if (body.length > 5_000_000) req.destroy(); }); // max 5mb
  req.on('end', () => { try { cb(null, JSON.parse(body)); } catch(e) { cb(e); } });
}

// Constant-time secret comparison (prevents timing attacks)
function safeCompare(a, b) {
  try {
    return crypto.timingSafeEqual(Buffer.from(String(a)), Buffer.from(String(b)));
  } catch { return false; }
}

function getClientIp(req) {
  return (req.headers['x-forwarded-for'] || '').split(',')[0].trim()
      || req.socket.remoteAddress || 'unknown';
}

function setCORSHeaders(req, res) {
  const origin = req.headers['origin'] || '';
  if (ALLOWED_ORIGINS.includes(origin)) {
    res.setHeader('Access-Control-Allow-Origin', origin);
    res.setHeader('Vary', 'Origin');
  }
  res.setHeader('Access-Control-Allow-Methods', 'GET,POST,OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, X-Admin-Secret');
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('X-Frame-Options', 'SAMEORIGIN');
  res.setHeader('X-XSS-Protection', '1; mode=block');
}

const MIME = {
  '.html': 'text/html', '.css': 'text/css', '.js': 'application/javascript',
  '.json': 'application/json', '.png': 'image/png', '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.woff': 'font/woff', '.woff2': 'font/woff2',
  '.ttf': 'font/ttf', '.webp': 'image/webp',
  '.xml': 'application/xml', '.txt': 'text/plain'
};

function serveStatic(req, res) {
  // Strip query string from file path
  let reqPath = req.url.split('?')[0];
  // Basic path traversal protection
  const safePath = path.normalize(reqPath).replace(/^(\.\.[\/\\])+/, '');
  let filePath = path.join(__dirname, safePath === '/' ? 'index.html' : safePath);
  // Must stay within project dir
  if (!filePath.startsWith(__dirname)) {
    res.writeHead(403); res.end('Forbidden'); return;
  }
  if (!fs.existsSync(filePath)) filePath = path.join(__dirname, 'index.html');
  const ext = path.extname(filePath);
  const mime = MIME[ext] || 'application/octet-stream';
  fs.readFile(filePath, (err, data) => {
    if (err) { res.writeHead(404); res.end('Not found'); return; }
    res.writeHead(200, { 'Content-Type': mime });
    res.end(data);
  });
}

// ─── PAYMENT VALIDATION ──────────────────────────────────────────────────────
const MIN_PAYMENT = 1.00;    // R$ 1,00
const MAX_PAYMENT = 50000.0; // R$ 50.000,00

function validateAmount(amount) {
  const v = parseFloat(amount);
  if (isNaN(v) || v < MIN_PAYMENT || v > MAX_PAYMENT) return null;
  return Math.round(v * 100) / 100; // 2 decimal places
}

// ─── SERVER ──────────────────────────────────────────────────────────────────
const server = http.createServer((req, res) => {
  const parsed = url.parse(req.url, true);
  const pathname = parsed.pathname;
  const ip = getClientIp(req);

  setCORSHeaders(req, res);
  if (req.method === 'OPTIONS') { res.writeHead(204); res.end(); return; }

  // ── POST /api/mp/preference ──────────────────────────────────────────────
  if (pathname === '/api/mp/preference' && req.method === 'POST') {
    if (rateLimit(ip, 20)) { res.writeHead(429); res.end(JSON.stringify({error:'rate limit'})); return; }

    readBody(req, (err, body) => {
      if (err) { res.writeHead(400); res.end(JSON.stringify({error:'bad json'})); return; }

      const items = (body.items || []).map(i => {
        const price = validateAmount(i.unit_price);
        if (!price) return null;
        return {
          title: String(i.title || '').slice(0, 256),
          quantity: Math.max(1, Math.min(99, parseInt(i.quantity) || 1)),
          unit_price: price,
          currency_id: 'BRL'
        };
      }).filter(Boolean);

      if (!items.length) { res.writeHead(400); res.end(JSON.stringify({error:'invalid items'})); return; }

      const payload = {
        items,
        payer: { email: String((body.payer && body.payer.email) || '').slice(0, 254) },
        payment_methods: { excluded_payment_types: [], installments: 12 },
        back_urls: {
          success: 'https://powerpy-site-production.up.railway.app/sucesso',
          failure: 'https://powerpy-site-production.up.railway.app/erro',
          pending: 'https://powerpy-site-production.up.railway.app/pendente'
        },
        auto_return: 'approved',
        statement_descriptor: 'POWERPY'
      };

      mpRequest('POST', '/checkout/preferences', payload, (err, data, status) => {
        if (err) { res.writeHead(500); res.end(JSON.stringify({error:'mp error'})); return; }
        res.writeHead(status, {'Content-Type':'application/json'});
        res.end(JSON.stringify(data));
      });
    });
    return;
  }

  // ── POST /api/mp/pix ─────────────────────────────────────────────────────
  if (pathname === '/api/mp/pix' && req.method === 'POST') {
    if (rateLimit(ip, 10)) { res.writeHead(429); res.end(JSON.stringify({error:'rate limit'})); return; }

    readBody(req, (err, body) => {
      if (err) { res.writeHead(400); res.end(JSON.stringify({error:'bad json'})); return; }

      const amount = validateAmount(body.amount);
      if (!amount) { res.writeHead(400); res.end(JSON.stringify({error:'invalid amount'})); return; }

      // CPF: only digits, 11 chars
      const cpf = String(body.cpf || '').replace(/\D/g, '').slice(0, 11);
      if (cpf.length !== 11) { res.writeHead(400); res.end(JSON.stringify({error:'invalid cpf'})); return; }

      const email = String(body.email || '').slice(0, 254);
      if (!email.includes('@')) { res.writeHead(400); res.end(JSON.stringify({error:'invalid email'})); return; }

      const payload = {
        transaction_amount: amount,
        description: String(body.description || 'Pedido PowerPy').slice(0, 256),
        payment_method_id: 'pix',
        payer: {
          email,
          first_name: String(body.nome || 'Cliente').slice(0, 60),
          last_name:  String(body.sobrenome || 'PowerPy').slice(0, 60),
          identification: { type: 'CPF', number: cpf }
        }
      };

      mpRequest('POST', '/v1/payments', payload, (err, data, status) => {
        if (err) { res.writeHead(500); res.end(JSON.stringify({error:'mp error'})); return; }
        res.writeHead(status, {'Content-Type':'application/json'});
        res.end(JSON.stringify(data));
      });
    });
    return;
  }

  // ── POST /api/mp/payment (cartão) ─────────────────────────────────────────
  if (pathname === '/api/mp/payment' && req.method === 'POST') {
    if (rateLimit(ip, 10)) { res.writeHead(429); res.end(JSON.stringify({error:'rate limit'})); return; }

    readBody(req, (err, body) => {
      if (err) { res.writeHead(400); res.end(JSON.stringify({error:'bad json'})); return; }

      const amount = validateAmount(body.transaction_amount);
      if (!amount) { res.writeHead(400); res.end(JSON.stringify({error:'invalid amount'})); return; }

      // Only forward safe fields to MP — never proxy raw body
      const payload = {
        token:              String(body.token || ''),
        installments:       Math.max(1, Math.min(12, parseInt(body.installments) || 1)),
        transaction_amount: amount,
        description:        String(body.description || 'Pedido PowerPy').slice(0, 256),
        payment_method_id:  String(body.payment_method_id || '').slice(0, 50),
        payer: {
          email: String((body.payer && body.payer.email) || '').slice(0, 254),
          identification: {
            type:   String((body.payer && body.payer.identification && body.payer.identification.type) || 'CPF'),
            number: String((body.payer && body.payer.identification && body.payer.identification.number) || '').replace(/\D/g,'').slice(0,14)
          }
        }
      };

      mpRequest('POST', '/v1/payments', payload, (err, data, status) => {
        if (err) { res.writeHead(500); res.end(JSON.stringify({error:'mp error'})); return; }
        res.writeHead(status, {'Content-Type':'application/json'});
        res.end(JSON.stringify(data));
      });
    });
    return;
  }

  // ── GET /api/mp/payment-status ───────────────────────────────────────────
  if (pathname === '/api/mp/payment-status' && req.method === 'GET') {
    if (rateLimit(ip, 60)) { res.writeHead(429); res.end(JSON.stringify({error:'rate limit'})); return; }
    const payId = String(parsedUrl.query.id || '').replace(/\D/g,'').slice(0,20);
    if (!payId) { res.writeHead(400); res.end(JSON.stringify({error:'missing id'})); return; }
    mpRequest('GET', `/v1/payments/${payId}`, null, (err, data, status) => {
      if (err) { res.writeHead(500); res.end(JSON.stringify({error:'mp error'})); return; }
      res.writeHead(status, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ status: data.status, id: data.id }));
    });
    return;
  }

  // ── GET /api/mp/pubkey ────────────────────────────────────────────────────
  if (pathname === '/api/mp/pubkey' && req.method === 'GET') {
    if (rateLimit(ip, 30)) { res.writeHead(429); res.end(JSON.stringify({error:'rate limit'})); return; }
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ public_key: PUBLIC_KEY }));
    return;
  }

  // ── GET /api/products ─────────────────────────────────────────────────────
  if (pathname === '/api/products' && req.method === 'GET') {
    if (productsCache) {
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify(productsCache));
    } else {
      res.writeHead(404, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'no products override'}));
    }
    return;
  }

  // ── POST /api/admin/save ──────────────────────────────────────────────────
  if (pathname === '/api/admin/save' && req.method === 'POST') {
    if (rateLimit(ip, 5)) { res.writeHead(429); res.end(JSON.stringify({error:'rate limit'})); return; }

    readBody(req, (err, body) => {
      if (err) { res.writeHead(400); res.end(JSON.stringify({error:'bad json'})); return; }

      // Accept secret ONLY via header (not query string — avoids server logs exposure)
      const secret = req.headers['x-admin-secret'];
      if (!secret || !safeCompare(secret, ADMIN_SECRET)) {
        res.writeHead(401); res.end(JSON.stringify({error:'unauthorized'})); return;
      }

      const products = body.products;
      if (!products) { res.writeHead(400); res.end(JSON.stringify({error:'no products'})); return; }

      const fileContent = JSON.stringify(products, null, 2);
      const encoded = Buffer.from(fileContent).toString('base64');

      githubRequest('GET', `/repos/${GH_REPO}/contents/products.json?ref=${GH_BRANCH}`, null, (err, data) => {
        const sha = (!err && data && data.sha) ? data.sha : undefined;
        const payload = { message: 'update products via admin panel', content: encoded, branch: GH_BRANCH };
        if (sha) payload.sha = sha;

        githubRequest('PUT', `/repos/${GH_REPO}/contents/products.json`, payload, (err2, data2, status2) => {
          if (err2 || status2 > 201) {
            res.writeHead(500, {'Content-Type':'application/json'});
            res.end(JSON.stringify({error: err2 ? err2.message : 'gh error'}));
            return;
          }
          productsCache = products;
          try { fs.writeFileSync(PRODUCTS_FILE, fileContent); } catch(e) {}
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:true, commit: data2.commit && data2.commit.sha}));
        });
      });
    });
    return;
  }

  // ── POST /api/lead ────────────────────────────────────────────────────────
  if (pathname === '/api/lead' && req.method === 'POST') {
    if (rateLimit(ip, 5)) { res.writeHead(429); res.end(JSON.stringify({error:'rate limit'})); return; }

    readBody(req, (err, body) => {
      if (err) { res.writeHead(400); res.end(JSON.stringify({error:'bad json'})); return; }

      const email = String(body.email || '');
      if (email && !email.includes('@')) {
        res.writeHead(400); res.end(JSON.stringify({error:'invalid email'})); return;
      }

      // Parse etiqueta if provided
      let etiqueta = null;
      if (body.etiqueta && typeof body.etiqueta === 'object') {
        etiqueta = {
          destinatario: String(body.etiqueta.destinatario || '').slice(0, 120),
          cpfCnpj:      String(body.etiqueta.cpfCnpj      || '').slice(0, 20),
          cep:          String(body.etiqueta.cep          || '').slice(0, 10),
          endereco:     String(body.etiqueta.endereco     || '').slice(0, 200),
          numero:       String(body.etiqueta.numero       || '').slice(0, 20),
          complemento:  String(body.etiqueta.complemento  || '').slice(0, 100),
          bairro:       String(body.etiqueta.bairro       || '').slice(0, 100),
          logradouro:   String(body.etiqueta.logradouro   || '').slice(0, 50),
        };
      }

      const lead = {
        id:        Date.now(),
        ts:        new Date().toISOString(),
        ip,
        nome:      String(body.nome      || '').slice(0, 120),
        email:     email.slice(0, 254),
        telefone:  String(body.telefone  || body.whatsapp || '').slice(0, 20),
        produto:   String(body.produto   || '').slice(0, 200),
        mensagem:  String(body.mensagem  || '').slice(0, 2000),
        tipo:      ['lead','pedido','contato'].includes(body.tipo) ? body.tipo : 'lead',
        etiqueta,
      };

      leadsStore.unshift(lead);
      if (leadsStore.length > 2000) leadsStore.splice(2000);
      saveLeadsTmp();

      // Persist to GitHub async (don't block response)
      persistLeadsToGH(err => {
        if (err) console.error('[leads] gh persist error:', err.message);
      });

      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(JSON.stringify({ok: true, id: lead.id}));
    });
    return;
  }

  // ── GET /api/leads ────────────────────────────────────────────────────────
  if (pathname === '/api/leads' && req.method === 'GET') {
    // Secret ONLY via header — never in query string
    const secret = req.headers['x-admin-secret'];
    if (!secret || !safeCompare(secret, ADMIN_SECRET)) {
      res.writeHead(401, {'Content-Type':'application/json'});
      res.end(JSON.stringify({error:'unauthorized'}));
      return;
    }
    res.writeHead(200, {'Content-Type':'application/json'});
    res.end(JSON.stringify({ total: leadsStore.length, leads: leadsStore }));
    return;
  }

  // ── GET /api/leads/csv ────────────────────────────────────────────────────
  if (pathname === '/api/leads/csv' && req.method === 'GET') {
    const secret = req.headers['x-admin-secret'];
    if (!secret || !safeCompare(secret, ADMIN_SECRET)) {
      res.writeHead(401); res.end('Unauthorized'); return;
    }
    const cols = ['id','ts','tipo','nome','email','telefone','produto','mensagem','ip'];
    const rows = leadsStore.map(l =>
      cols.map(c => `"${String(l[c] || '').replace(/"/g,'""')}"`).join(',')
    );
    const csv = [cols.join(','), ...rows].join('\n');
    res.writeHead(200, {
      'Content-Type': 'text/csv',
      'Content-Disposition': 'attachment; filename="leads-powerpy.csv"'
    });
    res.end(csv);
    return;
  }

  // ── POST /api/admin/stock ─────────────────────────────────────────────────
  if (pathname === '/api/admin/stock' && req.method === 'POST') {
    if (rateLimit(ip, 10)) { res.writeHead(429); res.end(JSON.stringify({error:'rate limit'})); return; }
    const secret = req.headers['x-admin-secret'];
    if (!secret || !safeCompare(secret, ADMIN_SECRET)) {
      res.writeHead(401); res.end(JSON.stringify({error:'unauthorized'})); return;
    }
    readBody(req, (err, body) => {
      if (err) { res.writeHead(400); res.end(JSON.stringify({error:'bad json'})); return; }
      const stock = body.stock;
      if (!stock || typeof stock !== 'object') {
        res.writeHead(400); res.end(JSON.stringify({error:'invalid stock'})); return;
      }
      // Persist stock to GitHub
      const fileContent = JSON.stringify(stock, null, 2);
      const encoded = Buffer.from(fileContent).toString('base64');
      githubRequest('GET', `/repos/${GH_REPO}/contents/stock.json?ref=${GH_BRANCH}`, null, (err, data) => {
        const sha = (!err && data && data.sha) ? data.sha : undefined;
        const payload = { message: 'update stock via admin panel', content: encoded, branch: GH_BRANCH };
        if (sha) payload.sha = sha;
        githubRequest('PUT', `/repos/${GH_REPO}/contents/stock.json`, payload, (err2, data2, status2) => {
          if (err2 || status2 > 201) {
            res.writeHead(500); res.end(JSON.stringify({error:'gh error'})); return;
          }
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:true}));
        });
      });
    });
    return;
  }

  // ── GET /api/admin/stock ──────────────────────────────────────────────────
  if (pathname === '/api/admin/stock' && req.method === 'GET') {
    const secret = req.headers['x-admin-secret'];
    if (!secret || !safeCompare(secret, ADMIN_SECRET)) {
      res.writeHead(401); res.end(JSON.stringify({error:'unauthorized'})); return;
    }
    githubRequest('GET', `/repos/${GH_REPO}/contents/stock.json?ref=${GH_BRANCH}`, null, (err, data) => {
      if (err || !data || !data.content) {
        res.writeHead(200, {'Content-Type':'application/json'});
        res.end(JSON.stringify({}));
        return;
      }
      const content = Buffer.from(data.content.replace(/\n/g,''), 'base64').toString('utf8');
      res.writeHead(200, {'Content-Type':'application/json'});
      res.end(content);
    });
    return;
  }

  // ── POST /api/admin/image ─────────────────────────────────────────────────
  if (pathname === '/api/admin/image' && req.method === 'POST') {
    if (rateLimit(ip, 5)) { res.writeHead(429); res.end(JSON.stringify({error:'rate limit'})); return; }
    const secret = req.headers['x-admin-secret'];
    if (!secret || !safeCompare(secret, ADMIN_SECRET)) {
      res.writeHead(401); res.end(JSON.stringify({error:'unauthorized'})); return;
    }
    readBody(req, (err, body) => {
      if (err) { res.writeHead(400); res.end(JSON.stringify({error:'bad json'})); return; }
      const { brand, idx, imageData, filename } = body;
      if (!brand || idx === undefined || !imageData) {
        res.writeHead(400); res.end(JSON.stringify({error:'missing fields'})); return;
      }
      // Save image to GitHub in /images/ folder
      const ext = (filename || 'image.jpg').split('.').pop().toLowerCase();
      const imgFilename = `${brand}_${idx}.${ext}`;
      const encoded = imageData.includes(',') ? imageData.split(',')[1] : imageData;
      githubRequest('GET', `/repos/${GH_REPO}/contents/images/${imgFilename}?ref=${GH_BRANCH}`, null, (err, data) => {
        const sha = (!err && data && data.sha) ? data.sha : undefined;
        const payload = { message: `upload image: ${imgFilename}`, content: encoded, branch: GH_BRANCH };
        if (sha) payload.sha = sha;
        githubRequest('PUT', `/repos/${GH_REPO}/contents/images/${imgFilename}`, payload, (err2, data2, status2) => {
          if (err2 || status2 > 201) {
            res.writeHead(500); res.end(JSON.stringify({error:'gh error saving image'})); return;
          }
          const imageUrl = `https://raw.githubusercontent.com/${GH_REPO}/${GH_BRANCH}/images/${imgFilename}`;
          res.writeHead(200, {'Content-Type':'application/json'});
          res.end(JSON.stringify({ok:true, url: imageUrl}));
        });
      });
    });
    return;
  }


  // ── Static files ──────────────────────────────────────────────────────────
  serveStatic(req, res);
});

server.listen(PORT, () => {
  console.log(`PowerPy server running on port ${PORT}`);
});

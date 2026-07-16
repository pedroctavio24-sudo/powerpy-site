// force-redeploy: 20260716215531
const https = require('https');
const crypto = require('crypto');

const GH_TOKEN     = process.env.GH_TOKEN;
const GH_REPO      = 'pedroctavio24-sudo/powerpy-site';
const GH_BRANCH    = 'main';
const ADMIN_SECRET = process.env.ADMIN_SECRET || 'pp2126';
const ACCESS_TOKEN = process.env.MP_ACCESS_TOKEN;
const PUBLIC_KEY   = process.env.MP_PUBLIC_KEY;

const ALLOWED_ORIGINS = [
  'https://powersuplepy.netlify.app',
  'https://powerpy-site-production.up.railway.app',
  'http://localhost:8899',
  'http://localhost:3000'
];

function safeCompare(a, b) {
  try { return crypto.timingSafeEqual(Buffer.from(String(a)), Buffer.from(String(b))); }
  catch { return false; }
}

function githubRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.github.com',
      path: endpoint,
      method,
      headers: {
        'Authorization': `token ${GH_TOKEN}`,
        'User-Agent': 'powerpy-netlify',
        'Content-Type': 'application/json',
        'Accept': 'application/vnd.github.v3+json'
      }
    };
    if (data) options.headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request(options, r => {
      let raw = '';
      r.on('data', c => raw += c);
      r.on('end', () => {
        try { resolve({ data: JSON.parse(raw), status: r.statusCode }); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function mpRequest(method, endpoint, body) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const options = {
      hostname: 'api.mercadopago.com',
      path: endpoint,
      method,
      headers: {
        'Authorization': `Bearer ${ACCESS_TOKEN}`,
        'Content-Type': 'application/json',
        'X-Idempotency-Key': crypto.randomUUID()
      }
    };
    if (data) options.headers['Content-Length'] = Buffer.byteLength(data);
    const req = https.request(options, r => {
      let raw = '';
      r.on('data', c => raw += c);
      r.on('end', () => {
        try { resolve({ data: JSON.parse(raw), status: r.statusCode }); }
        catch(e) { reject(e); }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

exports.handler = async (event, context) => {
  const origin = event.headers['origin'] || event.headers['Origin'] || '';
  const corsHeaders = {
    'Access-Control-Allow-Origin': ALLOWED_ORIGINS.includes(origin) ? origin : ALLOWED_ORIGINS[0],
    'Access-Control-Allow-Methods': 'GET,POST,OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Admin-Secret',
    'Vary': 'Origin'
  };

  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 204, headers: corsHeaders, body: '' };
  }

  const path = event.path.replace('/.netlify/functions/api', '').replace('/api', '') || '/';
  const method = event.httpMethod;
  const body = event.body ? JSON.parse(event.body) : {};
  const secret = event.headers['x-admin-secret'] || event.headers['X-Admin-Secret'] || '';

  const ok = (data, status=200) => ({
    statusCode: status,
    headers: { ...corsHeaders, 'Content-Type': 'application/json' },
    body: JSON.stringify(data)
  });
  const err = (msg, status=400) => ok({ error: msg }, status);

  try {
    // GET /products
    if (path === '/products' && method === 'GET') {
      const res = await githubRequest('GET', `/repos/${GH_REPO}/contents/products.json?ref=${GH_BRANCH}`);
      if (!res.data || !res.data.content) return err('no products', 404);
      const products = JSON.parse(Buffer.from(res.data.content.replace(/\n/g,''), 'base64').toString('utf8'));
      return ok(products);
    }

    // POST /lead
    if (path === '/lead' && method === 'POST') {
      const lead = {
        id: Date.now(),
        ts: new Date().toISOString(),
        nome: String(body.nome || '').slice(0, 120),
        email: String(body.email || '').slice(0, 254),
        telefone: String(body.telefone || body.whatsapp || '').slice(0, 20),
        produto: String(body.produto || '').slice(0, 200),
        mensagem: String(body.mensagem || '').slice(0, 2000),
        tipo: body.tipo || 'lead',
        etiqueta: body.etiqueta || null
      };
      // Load existing leads
      let leads = [];
      try {
        const res = await githubRequest('GET', `/repos/${GH_REPO}/contents/leads.json?ref=${GH_BRANCH}`);
        if (res.data && res.data.content) {
          leads = JSON.parse(Buffer.from(res.data.content.replace(/\n/g,''), 'base64').toString('utf8'));
        }
      } catch(e) {}
      leads.unshift(lead);
      if (leads.length > 2000) leads.splice(2000);
      // Save back
      const existing = await githubRequest('GET', `/repos/${GH_REPO}/contents/leads.json?ref=${GH_BRANCH}`).catch(() => null);
      const sha = existing && existing.data && existing.data.sha ? existing.data.sha : undefined;
      const payload = {
        message: `leads: auto-save ${new Date().toISOString()}`,
        content: Buffer.from(JSON.stringify(leads, null, 2)).toString('base64'),
        branch: GH_BRANCH
      };
      if (sha) payload.sha = sha;
      await githubRequest('PUT', `/repos/${GH_REPO}/contents/leads.json`, payload);
      return ok({ ok: true, id: lead.id });
    }

    // GET /leads
    if (path === '/leads' && method === 'GET') {
      if (!safeCompare(secret, ADMIN_SECRET)) return err('unauthorized', 401);
      const res = await githubRequest('GET', `/repos/${GH_REPO}/contents/leads.json?ref=${GH_BRANCH}`);
      if (!res.data || !res.data.content) return ok({ total: 0, leads: [] });
      const leads = JSON.parse(Buffer.from(res.data.content.replace(/\n/g,''), 'base64').toString('utf8'));
      return ok({ total: leads.length, leads });
    }

    // GET /leads/csv
    if (path === '/leads/csv' && method === 'GET') {
      if (!safeCompare(secret, ADMIN_SECRET)) return err('unauthorized', 401);
      const res = await githubRequest('GET', `/repos/${GH_REPO}/contents/leads.json?ref=${GH_BRANCH}`);
      const leads = res.data && res.data.content
        ? JSON.parse(Buffer.from(res.data.content.replace(/\n/g,''), 'base64').toString('utf8'))
        : [];
      const cols = ['id','ts','tipo','nome','email','telefone','produto','mensagem'];
      const rows = leads.map(l => cols.map(c => `"${String(l[c]||'').replace(/"/g,'""')}"`).join(','));
      const csv = [cols.join(','), ...rows].join('\n');
      return {
        statusCode: 200,
        headers: { ...corsHeaders, 'Content-Type': 'text/csv', 'Content-Disposition': 'attachment; filename="leads-powerpy.csv"' },
        body: csv
      };
    }

    // POST /admin/save
    if (path === '/admin/save' && method === 'POST') {
      if (!safeCompare(secret, ADMIN_SECRET)) return err('unauthorized', 401);
      if (!body.products) return err('no products');
      const fileContent = JSON.stringify(body.products, null, 2);
      const encoded = Buffer.from(fileContent).toString('base64');
      const existing = await githubRequest('GET', `/repos/${GH_REPO}/contents/products.json?ref=${GH_BRANCH}`).catch(() => null);
      const sha = existing && existing.data && existing.data.sha ? existing.data.sha : undefined;
      const payload = { message: 'update products via admin', content: encoded, branch: GH_BRANCH };
      if (sha) payload.sha = sha;
      const res = await githubRequest('PUT', `/repos/${GH_REPO}/contents/products.json`, payload);
      return ok({ ok: true });
    }

    // GET /admin/stock
    if (path === '/admin/stock' && method === 'GET') {
      if (!safeCompare(secret, ADMIN_SECRET)) return err('unauthorized', 401);
      const res = await githubRequest('GET', `/repos/${GH_REPO}/contents/stock.json?ref=${GH_BRANCH}`).catch(() => null);
      if (!res || !res.data || !res.data.content) return ok({});
      const stock = JSON.parse(Buffer.from(res.data.content.replace(/\n/g,''), 'base64').toString('utf8'));
      return ok(stock);
    }

    // POST /admin/stock
    if (path === '/admin/stock' && method === 'POST') {
      if (!safeCompare(secret, ADMIN_SECRET)) return err('unauthorized', 401);
      if (!body.stock) return err('invalid stock');
      const encoded = Buffer.from(JSON.stringify(body.stock, null, 2)).toString('base64');
      const existing = await githubRequest('GET', `/repos/${GH_REPO}/contents/stock.json?ref=${GH_BRANCH}`).catch(() => null);
      const sha = existing && existing.data && existing.data.sha ? existing.data.sha : undefined;
      const payload = { message: 'update stock via admin', content: encoded, branch: GH_BRANCH };
      if (sha) payload.sha = sha;
      await githubRequest('PUT', `/repos/${GH_REPO}/contents/stock.json`, payload);
      return ok({ ok: true });
    }

    // POST /admin/image
    if (path === '/admin/image' && method === 'POST') {
      if (!safeCompare(secret, ADMIN_SECRET)) return err('unauthorized', 401);
      const { brand, idx, imageData, filename } = body;
      if (!brand || idx === undefined || !imageData) return err('missing fields');
      const ext = (filename || 'image.jpg').split('.').pop().toLowerCase();
      const imgFilename = `${brand}_${idx}.${ext}`;
      const encoded = imageData.includes(',') ? imageData.split(',')[1] : imageData;
      const existing = await githubRequest('GET', `/repos/${GH_REPO}/contents/images/${imgFilename}?ref=${GH_BRANCH}`).catch(() => null);
      const sha = existing && existing.data && existing.data.sha ? existing.data.sha : undefined;
      const payload = { message: `upload image: ${imgFilename}`, content: encoded, branch: GH_BRANCH };
      if (sha) payload.sha = sha;
      await githubRequest('PUT', `/repos/${GH_REPO}/contents/images/${imgFilename}`, payload);
      const imageUrl = `https://raw.githubusercontent.com/${GH_REPO}/${GH_BRANCH}/images/${imgFilename}`;
      return ok({ ok: true, url: imageUrl });
    }

    // GET /mp/pubkey
    if (path === '/mp/pubkey' && method === 'GET') {
      return ok({ public_key: PUBLIC_KEY });
    }

    // POST /mp/pix
    if (path === '/mp/pix' && method === 'POST') {
      const amount = parseFloat(body.amount);
      if (!amount || amount < 1) return err('invalid amount');
      const cpf = String(body.cpf || '').replace(/\D/g, '').slice(0, 11);
      if (cpf.length !== 11) return err('invalid cpf');
      const payload = {
        transaction_amount: amount,
        description: String(body.description || 'Pedido PowerPy').slice(0, 256),
        payment_method_id: 'pix',
        payer: {
          email: String(body.email || ''),
          first_name: String(body.nome || 'Cliente').slice(0, 60),
          last_name: String(body.sobrenome || 'PowerPy').slice(0, 60),
          identification: { type: 'CPF', number: cpf }
        }
      };
      const res = await mpRequest('POST', '/v1/payments', payload);
      return ok(res.data, res.status);
    }

    // POST /mp/payment
    if (path === '/mp/payment' && method === 'POST') {
      const amount = parseFloat(body.transaction_amount);
      if (!amount || amount < 1) return err('invalid amount');
      const payload = {
        token: String(body.token || ''),
        installments: Math.max(1, Math.min(12, parseInt(body.installments) || 1)),
        transaction_amount: amount,
        description: String(body.description || 'Pedido PowerPy').slice(0, 256),
        payment_method_id: String(body.payment_method_id || '').slice(0, 50),
        payer: {
          email: String((body.payer && body.payer.email) || '').slice(0, 254),
          identification: {
            type: 'CPF',
            number: String((body.payer && body.payer.identification && body.payer.identification.number) || '').replace(/\D/g,'').slice(0, 14)
          }
        }
      };
      const res = await mpRequest('POST', '/v1/payments', payload);
      return ok(res.data, res.status);
    }

    // GET /mp/payment-status
    if (path === '/mp/payment-status' && method === 'GET') {
      const payId = String((event.queryStringParameters && event.queryStringParameters.id) || '').replace(/\D/g, '').slice(0, 20);
      if (!payId) return err('missing id', 400);
      const res = await mpRequest('GET', `/v1/payments/${payId}`);
      return ok({ status: res.data.status, id: res.data.id }, res.status);
    }

    return err('not found', 404);

  } catch(e) {
    console.error('Function error:', e);
    return err('server error', 500);
  }
};

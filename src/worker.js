
// MAHIRA FUELS — Cloudflare Worker
// Serves static website pages and handles /api/* using Supabase.
//
// Cloudflare secrets / variables:
// SUPABASE_URL
// SUPABASE_SERVICE_KEY (new Supabase sb_secret_ key)
// ADMIN_KEY
// RIDER_KEY (optional)
// ISSUER_KEY (optional)

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: {
      'content-type': 'application/json',
      'cache-control': 'no-store',
    },
  });

async function sb(env, path, { method = 'GET', body, prefer } = {}) {
  const res = await fetch(
    `${env.SUPABASE_URL}/rest/v1/${path}`,
    {
      method,
      headers: {
        // Supabase new secret keys belong in apikey only.
        apikey: env.SUPABASE_SERVICE_KEY,
        'content-type': 'application/json',
        ...(prefer ? { Prefer: prefer } : {}),
      },
      body: body === undefined ? undefined : JSON.stringify(body),
    }
  );

  const text = await res.text();
  let data = null;

  try {
    data = text ? JSON.parse(text) : null;
  } catch {
    data = text;
  }

  if (!res.ok) {
    throw new Error(
      `Supabase ${res.status}: ${
        typeof data === 'string' ? data : JSON.stringify(data)
      }`
    );
  }

  return data;
}

const BRANDS = ['ola', 'afrigas', 'seagas'];
const STATUSES = [
  'in_progress',
  'on_the_way',
  'delivered',
  'cancelled',
];

const TOKEN_RE = /^[a-f0-9]{20}$/;

const cleanCode = (c) =>
  String(c || '')
    .toUpperCase()
    .replace(/[^A-Z0-9-]/g, '')
    .slice(0, 40);

const cleanPhone = (p) => {
  let s = String(p || '').replace(/[^\d+]/g, '');

  if (/^0[17]\d{8}$/.test(s)) {
    s = '254' + s.slice(1);
  }

  if (/^\+254[17]\d{8}$/.test(s)) {
    s = s.slice(1);
  }

  return /^254[17]\d{8}$/.test(s) ? s : null;
};

function randomCode() {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(6));

  return (
    'MF-' +
    Array.from(bytes, (b) => alphabet[b % alphabet.length]).join('')
  );
}

// Creates discount codes.
async function createCodes(env, b) {
  const amount =
    Number.isInteger(b.amount) && b.amount > 0 && b.amount <= 5000
      ? b.amount
      : 50;

  const days =
    Number.isInteger(b.days) && b.days > 0 && b.days <= 365
      ? b.days
      : 30;

  let names = Array.isArray(b.names)
    ? b.names
    : b.name
      ? [b.name]
      : [];

  names = names
    .map((n) => String(n).trim().slice(0, 60))
    .filter(Boolean)
    .slice(0, 200);

  const count =
    names.length ||
    Math.min(Math.max(parseInt(b.count, 10) || 1, 1), 200);

  const expires_at = new Date(
    Date.now() + days * 86400000
  ).toISOString();

  const rows = Array.from({ length: count }, (_, i) => ({
    code: randomCode(),
    customer_name: names[i] || null,
    amount,
    expires_at,
  }));

  await sb(env, 'discount_codes', {
    method: 'POST',
    body: rows,
    prefer: 'return=minimal',
  });

  return rows;
}

const codeErrorText = {
  invalid_code: 'That code is not valid.',
  code_used: 'That code has already been used.',
  code_expired: 'That code has expired.',
};

// Only show an offer while it is running.
function publicProduct(p) {
  const live =
    p.promo_price != null &&
    (!p.promo_until || new Date(p.promo_until) > new Date());

  return {
    brand: p.brand,
    label: p.label,
    price: p.price,
    stock: p.stock,
    promo_price: live ? p.promo_price : null,
    promo_label: live ? p.promo_label : null,
    promo_until: live ? p.promo_until : null,
  };
}

const ORDER_COLS =
  'id,status,customer_name,phone,brand,total,payment_method,paid,products(label)';

async function handleApi(request, env, url) {
  const route = url.pathname;
  const method = request.method;

  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_KEY) {
    return json({
      error: 'Server is not configured yet (missing Supabase settings).',
    }, 500);
  }

  // ---------- PUBLIC ----------

  if (route === '/api/stock' && method === 'GET') {
    const rows = await sb(
      env,
      'products?select=brand,label,price,stock,promo_price,promo_label,promo_until&active=eq.true&order=brand'
    );

    return json({
      products: rows.map(publicProduct),
    });
  }

  if (route === '/api/validate-code' && method === 'POST') {
    const { code } = await request.json().catch(() => ({}));
    const c = cleanCode(code);

    if (!c) {
      return json({ ok: false, error: 'Enter a code.' });
    }

    const rows = await sb(
      env,
      `discount_codes?select=amount,expires_at,used_at,customer_name&code=eq.${encodeURIComponent(c)}`
    );

    const dc = rows[0];

    if (!dc) {
      return json({
        ok: false,
        error: codeErrorText.invalid_code,
      });
    }

    if (dc.used_at) {
      return json({
        ok: false,
        error: codeErrorText.code_used,
      });
    }

    if (new Date(dc.expires_at) < new Date()) {
      return json({
        ok: false,
        error: codeErrorText.code_expired,
      });
    }

    return json({
      ok: true,
      amount: dc.amount,
      name: dc.customer_name,
      expires_at: dc.expires_at,
    });
  }

  if (route === '/api/order' && method === 'POST') {
    const b = await request.json().catch(() => ({}));

    const brand = String(b.brand || '');
    const phone = cleanPhone(b.phone);

    const method_ =
      b.payment_method === 'cash'
        ? 'cash'
        : b.payment_method === 'mpesa'
          ? 'mpesa'
          : null;

    if (!BRANDS.includes(brand)) {
      return json({
        ok: false,
        error: 'Choose a gas brand.',
      }, 400);
    }

    if (!phone) {
      return json({
        ok: false,
        error: 'Enter a valid Kenyan phone number, e.g. 0712345678.',
      }, 400);
    }

    if (!method_) {
      return json({
        ok: false,
        error: 'Choose a payment method.',
      }, 400);
    }

    const name = String(b.name || '').trim().slice(0, 60);
    const ref = String(b.mpesa_ref || '').trim().slice(0, 20);

    const result = await sb(env, 'rpc/place_order', {
      method: 'POST',
      body: {
        p_brand: brand,
        p_name: name,
        p_phone: phone,
        p_code: cleanCode(b.code),
        p_method: method_,
        p_ref: ref,
      },
    });

    if (!result.ok) {
      const msg =
        result.error === 'out_of_stock'
          ? 'Sorry, this gas is now out of stock.'
          : codeErrorText[result.error] || 'Could not place the order.';

      return json({
        ok: false,
        error: msg,
        reason: result.error,
      }, 409);
    }

    return json(result);
  }

  // Customer order tracking.
  // GET /api/track?t=<token>

  if (route === '/api/track' && method === 'GET') {
    const t = url.searchParams.get('t') || '';

    if (!TOKEN_RE.test(t)) {
      return json({ error: 'Order not found.' }, 404);
    }

    const rows = await sb(
      env,
      `orders?track_token=eq.${t}&select=id,created_at,status,customer_name,total,discount,payment_method,paid,on_the_way_at,delivered_at,products(label)`
    );

    const o = rows[0];

    if (!o) {
      return json({ error: 'Order not found.' }, 404);
    }

    return json({
      id: o.id,
      status: o.status,
      name: o.customer_name,
      label: o.products?.label || '',
      total: o.total,
      discount: o.discount,
      payment_method: o.payment_method,
      paid: o.paid,
      created_at: o.created_at,
      on_the_way_at: o.on_the_way_at,
      delivered_at: o.delivered_at,
    });
  }

  // Rider/admin scanner.

  if (route === '/api/scan' && method === 'POST') {
    const k =
      request.headers.get('x-rider-key') ||
      request.headers.get('x-admin-key') ||
      '';

    const ok =
      (env.RIDER_KEY && k === env.RIDER_KEY) ||
      (env.ADMIN_KEY && k === env.ADMIN_KEY);

    if (!ok) {
      return json({ error: 'Wrong key.' }, 401);
    }

    const b = await request.json().catch(() => ({}));

    let token = String(b.token || '');

    try {
      token = new URL(token).searchParams.get('t') || token;
    } catch {
      // Plain token.
    }

    token = token.trim().toLowerCase();

    if (!TOKEN_RE.test(token)) {
      return json({
        ok: false,
        error: 'This is not a Mahira Fuels order code.',
      }, 400);
    }

    if (!['on_the_way', 'delivered'].includes(b.status)) {
      return json({ ok: false, error: 'Bad action.' }, 400);
    }

    const rows = await sb(
      env,
      `orders?track_token=eq.${token}&select=${ORDER_COLS}`
    );

    const o = rows[0];

    if (!o) {
      return json({
        ok: false,
        error: 'Order not found.',
      }, 404);
    }

    const summary = {
      id: o.id,
      name: o.customer_name,
      phone: o.phone,
      label: o.products?.label || o.brand,
      total: o.total,
      payment_method: o.payment_method,
      paid: o.paid,
    };

    const collect =
      o.payment_method === 'cash' && !o.paid
        ? o.total
        : 0;

    const r = await sb(env, 'rpc/set_order_status', {
      method: 'POST',
      body: {
        p_id: o.id,
        p_status: b.status,
      },
    });

    if (!r.ok) {
      const nice =
        String(r.error || '').startsWith('already_')
          ? `Already marked ${String(r.error).slice(8).replace('_', ' ')}.`
          : r.error === 'closed'
            ? `This order is already ${r.status}.`
            : 'Could not update this order.';

      return json({
        ok: false,
        error: nice,
        order: summary,
      }, 409);
    }

    return json({
      ok: true,
      status: b.status,
      collect: b.status === 'delivered' ? collect : 0,
      order: summary,
    });
  }

  // Main system: create discount codes.

  if (route === '/api/issue-code' && method === 'POST') {
    const key = request.headers.get('x-issuer-key') || '';

    if (!env.ISSUER_KEY || key !== env.ISSUER_KEY) {
      return json({ error: 'Wrong issuer key.' }, 401);
    }

    const b = await request.json().catch(() => ({}));
    const rows = await createCodes(env, b);

    return json({
      ok: true,
      codes: rows.map((r) => ({
        code: r.code,
        name: r.customer_name,
        amount: r.amount,
        expires_at: r.expires_at,
        link: `${url.origin}/?code=${encodeURIComponent(r.code)}`,
      })),
    });
  }

  // ---------- ADMIN ----------

  if (route.startsWith('/api/admin/')) {
    const key = request.headers.get('x-admin-key') || '';

    if (!env.ADMIN_KEY || key !== env.ADMIN_KEY) {
      return json({ error: 'Wrong admin key.' }, 401);
    }

    if (route === '/api/admin/stock' && method === 'GET') {
      return json({
        products: await sb(
          env,
          'products?select=brand,label,price,stock,promo_price,promo_label,promo_until&order=brand'
        ),
      });
    }

    if (route === '/api/admin/stock' && method === 'POST') {
      const b = await request.json().catch(() => ({}));

      if (!BRANDS.includes(b.brand)) {
        return json({ error: 'Unknown brand.' }, 400);
      }

      const patch = {};

      if (Number.isInteger(b.stock) && b.stock >= 0) {
        patch.stock = b.stock;
      }

      if (Number.isInteger(b.price) && b.price >= 0) {
        patch.price = b.price;
      }

      // Start or stop promotional offer.

      if ('promo' in b) {
        if (b.promo === null) {
          Object.assign(patch, {
            promo_price: null,
            promo_label: null,
            promo_until: null,
          });
        } else if (
          Number.isInteger(b.promo?.price) &&
          b.promo.price >= 0
        ) {
          const hours = Number(b.promo.hours);

          Object.assign(patch, {
            promo_price: b.promo.price,
            promo_label: String(
              b.promo.label || 'Special offer'
            ).trim().slice(0, 40),
            promo_until:
              hours > 0
                ? new Date(
                    Date.now() +
                    Math.min(hours, 24 * 60) * 3600000
                  ).toISOString()
                : null,
          });
        } else {
          return json({
            error: 'Enter the offer price.',
          }, 400);
        }
      }

      if (!Object.keys(patch).length) {
        return json({
          error: 'Nothing to update.',
        }, 400);
      }

      await sb(
        env,
        `products?brand=eq.${b.brand}`,
        {
          method: 'PATCH',
          body: patch,
        }
      );

      return json({ ok: true });
    }

    if (route === '/api/admin/codes' && method === 'POST') {
      const b = await request.json().catch(() => ({}));

      return json({
        ok: true,
        codes: await createCodes(env, b),
      });
    }

    if (route === '/api/admin/codes' && method === 'GET') {
      return json({
        codes: await sb(
          env,
          'discount_codes?select=*&order=created_at.desc&limit=200'
        ),
      });
    }

    if (route === '/api/admin/orders' && method === 'GET') {
      return json({
        orders: await sb(
          env,
          'orders?select=*&order=created_at.desc&limit=100'
        ),
      });
    }

    if (
      route === '/api/admin/orders/status' &&
      method === 'POST'
    ) {
      const { id, status } =
        await request.json().catch(() => ({}));

      if (
        !Number.isInteger(id) ||
        !STATUSES.includes(status)
      ) {
        return json({ error: 'Bad request.' }, 400);
      }

      return json(
        await sb(env, 'rpc/set_order_status', {
          method: 'POST',
          body: {
            p_id: id,
            p_status: status,
          },
        })
      );
    }

    if (
      route === '/api/admin/orders/paid' &&
      method === 'POST'
    ) {
      const { id, paid } =
        await request.json().catch(() => ({}));

      if (!Number.isInteger(id)) {
        return json({ error: 'Bad order id.' }, 400);
      }

      await sb(env, `orders?id=eq.${id}`, {
        method: 'PATCH',
        body: {
          paid: paid !== false,
        },
      });

      return json({ ok: true });
    }

    if (
      route === '/api/admin/customers' &&
      method === 'GET'
    ) {
      return json({
        customers: await sb(
          env,
          'customers?select=*&order=last_order_at.desc&limit=500'
        ),
      });
    }
  }

  return json({ error: 'Not found' }, 404);
}

// ---------- MAIN WORKER ----------

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname.startsWith('/api/')) {
      try {
        return await handleApi(request, env, url);
      } catch (e) {
        // Detailed error is available in Cloudflare Worker logs.
        console.error('MAHIRA API ERROR:', e);

        return json({
          error: 'Something went wrong. Please try again.',
        }, 500);
      }
    }

    return env.ASSETS.fetch(request);
  },
};

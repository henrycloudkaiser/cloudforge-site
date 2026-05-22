// Cloud Forge — Stripe Checkout session creator.
// The browser POSTs { email, material, volumeCm3, designName } and gets back
// { checkoutUrl } which it redirects to. Stripe handles the payment form.
//
// Pricing today is a placeholder formula (see PRICE_* constants). When the
// Craftcloud / Treatstock API is wired in, replace `quoteCents` with a real
// quote from that service.

const Stripe = require('stripe');

// ─── Pricing knobs ──────────────────────────────────────────────────────────
const PRICE_SETUP_CENTS    = 400;   // flat per-order setup fee
const PRICE_PER_CM3_CENTS  = 100;   // $1.00 per cm³
const PRICE_MIN_CENTS      = 1000;  // $10 minimum to cover shipping
const SHIPPING_CENTS       = 500;   // $5 ground shipping placeholder
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_MATERIALS = new Set(['pla', 'petg', 'abs']);

// Tiny utility: respond with CORS headers so the function works whether the
// browser is on the Netlify subdomain OR a custom domain like cloudforge3d.com
const cors = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

exports.handler = async (event) => {
  if (event.httpMethod === 'OPTIONS') {
    return { statusCode: 200, headers: cors, body: '' };
  }
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, headers: cors, body: 'Method Not Allowed' };
  }

  let payload;
  try { payload = JSON.parse(event.body || '{}'); }
  catch { return { statusCode: 400, headers: cors, body: 'Invalid JSON' }; }

  const { email, material, volumeCm3, designName } = payload;

  // ── Validate input ────────────────────────────────────────────────────────
  if (!email || !/^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(email)) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Valid email required' }) };
  }
  if (!ALLOWED_MATERIALS.has(material)) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid material' }) };
  }
  const volume = Number(volumeCm3);
  if (!isFinite(volume) || volume <= 0 || volume > 5000) {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Invalid volume' }) };
  }

  // ── Compute price (placeholder until Craftcloud API is wired in) ──────────
  const printCents = Math.max(
    PRICE_MIN_CENTS,
    PRICE_SETUP_CENTS + Math.round(volume * PRICE_PER_CM3_CENTS)
  );
  const totalCents = printCents + SHIPPING_CENTS;

  // ── Build the Stripe Checkout session ─────────────────────────────────────
  const stripe = Stripe(process.env.STRIPE_SECRET);
  const origin = event.headers.origin || event.headers.referer?.replace(/\/$/, '') || '';
  const name = (designName || 'CloudForge design').slice(0, 60);

  try {
    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      customer_email: email,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `${name} — ${material.toUpperCase()}`,
              description: `Volume ${volume.toFixed(2)} cm³ · ${material.toUpperCase()} · printed and shipped`,
            },
            unit_amount: printCents,
          },
          quantity: 1,
        },
        {
          price_data: {
            currency: 'usd',
            product_data: { name: 'Shipping' },
            unit_amount: SHIPPING_CENTS,
          },
          quantity: 1,
        },
      ],
      shipping_address_collection: {
        allowed_countries: ['US', 'CA', 'GB', 'AU', 'DE', 'FR', 'NL', 'IE', 'IT', 'ES', 'SE', 'DK', 'NO', 'FI'],
      },
      success_url: `${origin}/?ordered=success&session={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${origin}/?ordered=cancel`,
      metadata: {
        material,
        volumeCm3: String(volume),
        designName: name,
      },
    });

    return {
      statusCode: 200,
      headers: { ...cors, 'Content-Type': 'application/json' },
      body: JSON.stringify({ checkoutUrl: session.url, priceCents: totalCents }),
    };
  } catch (err) {
    console.error('Stripe error:', err);
    return {
      statusCode: 500,
      headers: cors,
      body: JSON.stringify({ error: 'Could not create checkout session', detail: err.message }),
    };
  }
};

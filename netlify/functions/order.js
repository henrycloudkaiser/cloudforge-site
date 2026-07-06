// Cloud Forge — Stripe Checkout session creator.
// The browser POSTs { email, material, volumeCm3, designName, stlBase64 } and
// gets back { checkoutUrl } which it redirects to. Stripe handles the payment
// form. We also stash the STL in Netlify Blobs under the Stripe session ID so
// the post-payment webhook can attach it to the fulfillment email.
//
// Pricing today is a placeholder formula (see PRICE_* constants). When the
// Craftcloud / Treatstock API is wired in, replace `quoteCents` with a real
// quote from that service.

const Stripe = require('stripe');
const { getStore } = require('@netlify/blobs');

// ─── Pricing knobs ──────────────────────────────────────────────────────────
// Tuned to mirror real aggregator (Craftcloud-class) print-farm rates so the
// placeholder is in the right ballpark until the real Craftcloud API quotes
// replace this entirely. MUST stay in sync with PRICE in index.html.
const PRICE_SETUP_CENTS    = 300;   // flat per-order setup fee
const PRICE_PER_CM3_CENTS  = 20;    // $0.20 per cm³ — realistic PLA rate
const PRICE_MIN_CENTS      = 600;   // $6 minimum to cover handling
const SHIPPING_CENTS       = 500;   // $5 ground shipping placeholder
// ─────────────────────────────────────────────────────────────────────────────

const ALLOWED_MATERIALS = new Set(['pla', 'petg', 'abs']);

// ── Coupons (server-side authoritative) ────────────────────────────────
// Keep this small and hand-audited — this is real money. If any of these
// values ever fall out of sync with what index.html shows, THIS is the
// source of truth. Client-side display is just a preview.
const COUPONS = {
  bambi: { pct: 100, label: 'Bambi friends-and-family' },
};
const normalizeCoupon = (raw) => (raw || '').trim().toLowerCase();

// Cap the STL upload at 5 MB (base64 → ~3.75 MB binary). Netlify functions
// have a 6 MB request ceiling; this leaves room for the rest of the payload.
const MAX_STL_BASE64_BYTES = 5 * 1024 * 1024;

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

  const { email, material, color, couponCode, feedback, volumeCm3, designName, stlBase64 } = payload;

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
  if (!stlBase64 || typeof stlBase64 !== 'string') {
    return { statusCode: 400, headers: cors, body: JSON.stringify({ error: 'Missing STL payload' }) };
  }
  if (stlBase64.length > MAX_STL_BASE64_BYTES) {
    return { statusCode: 413, headers: cors, body: JSON.stringify({ error: 'STL too large (5 MB max)' }) };
  }

  // ── Compute price (placeholder until Craftcloud API is wired in) ──────────
  let printCents = Math.max(
    PRICE_MIN_CENTS,
    PRICE_SETUP_CENTS + Math.round(volume * PRICE_PER_CM3_CENTS)
  );
  let shippingCents = SHIPPING_CENTS;

  // ── Apply coupon (server-side authoritative) ─────────────────────────────
  const couponKey = normalizeCoupon(couponCode);
  const coupon = couponKey ? COUPONS[couponKey] : null;
  const appliedCoupon = coupon ? couponKey : '';
  if (coupon && coupon.pct === 100) {
    // Full-freebie: print + shipping both go to zero. Friends & family flow.
    printCents = 0;
    shippingCents = 0;
  } else if (coupon && coupon.pct > 0) {
    // Reserved for future percent-off coupons.
    const factor = (100 - coupon.pct) / 100;
    printCents    = Math.round(printCents    * factor);
    shippingCents = Math.round(shippingCents * factor);
  }
  const totalCents = printCents + shippingCents;

  // ── Build the Stripe Checkout session ─────────────────────────────────────
  const stripe = Stripe(process.env.STRIPE_SECRET);
  const origin = event.headers.origin || event.headers.referer?.replace(/\/$/, '') || '';
  const name = (designName || 'CloudForge design').slice(0, 60);

  try {
    // Stripe requires a minimum $0.50 line item for card mode. If the total
    // is $0 (bambi coupon), we bump line items to their pre-discount price
    // and attach a session-level discount so Stripe still displays a
    // sensible receipt AND still collects the shipping address on their UI.
    // `payment_method_collection: 'if_required'` skips the card form when
    // the final amount is 0 — perfect for the friends-and-family free flow.
    const isFree = totalCents === 0;
    const displayPrintCents = isFree
      ? Math.max(PRICE_MIN_CENTS, PRICE_SETUP_CENTS + Math.round(volume * PRICE_PER_CM3_CENTS))
      : printCents;
    const displayShipCents = isFree ? SHIPPING_CENTS : shippingCents;

    // For a bambi/free order we mint (or reuse) a 100%-off Stripe coupon so
    // the checkout displays the discount cleanly and the total lands at $0.
    let discounts;
    if (isFree && appliedCoupon) {
      const couponId = 'cf_' + appliedCoupon + '_100off';
      try {
        await stripe.coupons.retrieve(couponId);
      } catch (_) {
        await stripe.coupons.create({
          id: couponId,
          percent_off: 100,
          duration: 'forever',
          name: coupon.label || appliedCoupon,
        });
      }
      discounts = [{ coupon: couponId }];
    }

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      payment_method_collection: 'if_required',
      customer_email: email,
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: `${name} — ${material.toUpperCase()}${color ? ' ' + color : ''}`,
              description: `Volume ${volume.toFixed(2)} cm³ · ${material.toUpperCase()} · printed and shipped`,
            },
            unit_amount: displayPrintCents,
          },
          quantity: 1,
        },
        {
          price_data: {
            currency: 'usd',
            product_data: { name: 'Shipping' },
            unit_amount: displayShipCents,
          },
          quantity: 1,
        },
      ],
      ...(discounts ? { discounts } : {}),
      shipping_address_collection: {
        allowed_countries: ['US', 'CA', 'GB', 'AU', 'DE', 'FR', 'NL', 'IE', 'IT', 'ES', 'SE', 'DK', 'NO', 'FI'],
      },
      success_url: `${origin}/?ordered=success&session={CHECKOUT_SESSION_ID}`,
      cancel_url:  `${origin}/?ordered=cancel`,
      metadata: {
        material,
        color: color || 'tan',
        volumeCm3: String(volume),
        designName: name,
        coupon: appliedCoupon,
        // Stripe metadata caps each value at 500 chars — truncate to fit
        feedback: (feedback || '').slice(0, 480),
      },
    });

    // Stash the STL keyed by session ID. The Stripe webhook reads this back
    // after payment confirms and attaches it to the fulfillment email.
    // STL files are too large for Stripe metadata (500-char cap per key).
    const store = getStore('order-stl');
    await store.set(session.id, stlBase64, {
      metadata: { email, material, color: color || 'tan', volumeCm3: String(volume), designName: name, coupon: appliedCoupon },
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

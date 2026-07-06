// Cloud Forge — Stripe webhook handler.
//
// HOW THIS WIRES UP:
//   Stripe → POST /.netlify/functions/stripe-webhook → this function runs.
//   On a successful `checkout.session.completed` event we:
//     1. Pull the STL we stashed in Netlify Blobs (keyed by session ID)
//     2. Email it to cloudforge3d@gmail.com so Henry can print on the
//        Bambu A1 mini while we're in test mode
//     3. Delete the blob so we don't pile up STL files forever
//
// REQUIRED ENVIRONMENT VARIABLES (set in Netlify → Site → Environment):
//   STRIPE_SECRET           — already exists, used by order.js
//   STRIPE_WEBHOOK_SECRET   — get this when you create the webhook endpoint
//                             in the Stripe dashboard (it starts with `whsec_`)
//   GMAIL_USER              — cloudforge3d@gmail.com
//   GMAIL_APP_PASSWORD      — a Gmail "App Password" (NOT the account password).
//                             Create one at https://myaccount.google.com/apppasswords
//                             with 2FA enabled. 16 chars, no spaces.
//   FULFILLMENT_EMAIL       — (optional) override destination, defaults to GMAIL_USER
//
// HOW TO REGISTER THE WEBHOOK WITH STRIPE:
//   1. Stripe dashboard → Developers → Webhooks → Add endpoint
//   2. URL: https://YOUR-DOMAIN/.netlify/functions/stripe-webhook
//   3. Events: select `checkout.session.completed`
//   4. Copy the signing secret into STRIPE_WEBHOOK_SECRET
//
// IMPORTANT: this function needs the RAW request body to verify the Stripe
// signature, so we disable Netlify's automatic JSON parsing by reading
// event.body directly.

const Stripe = require('stripe');
const { getStore } = require('@netlify/blobs');
const nodemailer = require('nodemailer');

exports.handler = async (event) => {
  if (event.httpMethod !== 'POST') {
    return { statusCode: 405, body: 'Method Not Allowed' };
  }

  const stripe = Stripe(process.env.STRIPE_SECRET);
  const sig = event.headers['stripe-signature'];
  const whSecret = process.env.STRIPE_WEBHOOK_SECRET;

  // Netlify may base64-encode bodies for binary content types; Stripe sends
  // JSON so it's usually plain. Handle both to be safe.
  const rawBody = event.isBase64Encoded
    ? Buffer.from(event.body, 'base64').toString('utf8')
    : event.body;

  let stripeEvent;
  try {
    stripeEvent = stripe.webhooks.constructEvent(rawBody, sig, whSecret);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return { statusCode: 400, body: `Webhook Error: ${err.message}` };
  }

  // We only care about checkout completion. Stripe re-sends other events too
  // (refunds, disputes, etc.) — ignore them with a 200 so Stripe doesn't retry.
  if (stripeEvent.type !== 'checkout.session.completed') {
    return { statusCode: 200, body: 'ignored' };
  }

  const session = stripeEvent.data.object;
  const sessionId = session.id;

  try {
    // 1. Retrieve the STL we stashed when the checkout session was created
    const store = getStore('order-stl');
    const stlBase64 = await store.get(sessionId);
    if (!stlBase64) {
      console.error('No STL found in blob store for session', sessionId);
      return { statusCode: 200, body: 'no stl on file' };
    }
    const stlBuffer = Buffer.from(stlBase64, 'base64');

    // 2. Pull order details from session metadata
    const md = session.metadata || {};
    const material   = (md.material   || 'pla').toUpperCase();
    const color      = md.color      || 'tan';
    const volumeCm3  = md.volumeCm3  || '?';
    const designName = md.designName || 'CloudForge design';
    const coupon     = md.coupon     || '';
    const feedback   = md.feedback   || '';
    const customerEmail   = session.customer_email || session.customer_details?.email || 'unknown';
    const shipping        = session.shipping_details || session.collected_information?.shipping_details || null;
    const amountTotal     = (session.amount_total || 0) / 100;
    const currency        = (session.currency || 'usd').toUpperCase();

    // 3. Format the shipping address as a readable block for the email body
    let shippingBlock = 'No shipping address on file';
    if (shipping?.address) {
      const a = shipping.address;
      shippingBlock = [
        shipping.name,
        a.line1,
        a.line2,
        `${a.city || ''}${a.state ? ', ' + a.state : ''} ${a.postal_code || ''}`.trim(),
        a.country,
      ].filter(Boolean).join('\n');
    }

    // 4. Build a safe filename — strip anything that isn't filesystem-safe
    const safeName = designName.replace(/[^a-zA-Z0-9_\- ]/g, '').replace(/\s+/g, '-').slice(0, 40) || 'design';
    const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    const filename = `cloudforge-${safeName}-${stamp}.stl`;

    // 5. Send the email via Gmail SMTP
    const transporter = nodemailer.createTransport({
      service: 'gmail',
      auth: {
        user: process.env.GMAIL_USER,
        pass: process.env.GMAIL_APP_PASSWORD,
      },
    });

    const to = process.env.FULFILLMENT_EMAIL || process.env.GMAIL_USER;
    const couponTag = coupon ? ` [${coupon.toUpperCase()}]` : '';
    const subject = `🛠️ New Cloud Forge order — ${designName} (${material} ${color})${couponTag}`;
    const body = [
      coupon
        ? `A new Cloud Forge FREE order (coupon: ${coupon}) is confirmed and ready to print.`
        : `A new Cloud Forge order is paid and ready to print.`,
      ``,
      `Design:    ${designName}`,
      `Material:  ${material} ${color}`,
      `Volume:    ${volumeCm3} cm³`,
      `Total:     ${amountTotal.toFixed(2)} ${currency}${coupon ? ' (100% off — ' + coupon + ')' : ''}`,
      `Customer:  ${customerEmail}`,
      `Stripe ID: ${sessionId}`,
      ...(feedback ? [``, `── User feedback ────────────────────────────`, feedback, `─────────────────────────────────────────────`] : []),
      ``,
      `Ship to:`,
      shippingBlock,
      ``,
      `The print-ready STL is attached. It is already oriented Z-up with the`,
      `lowest point at Z=0, so you can drop it straight into Bambu Studio.`,
    ].join('\n');

    await transporter.sendMail({
      from: `Cloud Forge Orders <${process.env.GMAIL_USER}>`,
      to,
      subject,
      text: body,
      attachments: [
        { filename, content: stlBuffer, contentType: 'model/stl' },
      ],
    });

    // 6. Clean up the blob so we don't store STLs forever
    await store.delete(sessionId);

    return { statusCode: 200, body: 'ok' };
  } catch (err) {
    console.error('Fulfillment email failed for session', sessionId, err);
    // Return 500 so Stripe retries — transient SMTP/blob failures should
    // self-heal on the retry.
    return { statusCode: 500, body: 'fulfillment failed' };
  }
};

// server.js
// Minimal real e-commerce backend: product catalog, Stripe Checkout, and
// payment-gated digital file delivery. Physical items just get recorded on
// the order (you'd fulfill/ship them yourself); digital items become
// viewable/downloadable on the success page only after Stripe confirms payment.

require('dotenv').config();
const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const Stripe = require('stripe');

const app = express();
const PORT = process.env.PORT || 3000;
const stripe = Stripe(process.env.STRIPE_SECRET_KEY || '');

const ORDERS_FILE = path.join(__dirname, 'data', 'orders.json');
const FILES_DIR = path.join(__dirname, 'files');

const PRODUCTS = [
  { id: 1, name: 'تيشيرت أساسي قطن', cat: 'clothes', price: 89, digital: false },
  { id: 2, name: 'هودي شتوي مبطّن', cat: 'clothes', price: 189, digital: false },
  { id: 3, name: 'كاب رياضي قابل للتعديل', cat: 'clothes', price: 69, digital: false },
  { id: 4, name: 'قميص كاجوال قصير الكم', cat: 'clothes', price: 119, digital: false },
  { id: 5, name: 'حقيبة ظهر يومية', cat: 'accessories', price: 159, digital: false },
  { id: 6, name: 'كوب حراري ستانلس', cat: 'accessories', price: 59, digital: false },
  { id: 7, name: 'محفظة جلد طبيعي', cat: 'accessories', price: 129, digital: false },
  { id: 8, name: 'نظارة شمسية كلاسيك', cat: 'accessories', price: 99, digital: false },
  { id: 9, name: 'دليل صناعة المحتوى الاحترافي (PDF)', cat: 'digital', price: 49, digital: true, file: 'content-creator-guide.pdf' },
  { id: 10, name: 'قالب تخطيط أسبوعي (PDF)', cat: 'digital', price: 19, digital: true, file: 'weekly-planner-template.pdf' },
];

function getProduct(id) {
  return PRODUCTS.find(p => p.id === Number(id));
}

function readOrders() {
  try {
    return JSON.parse(fs.readFileSync(ORDERS_FILE, 'utf-8'));
  } catch {
    return {};
  }
}
function writeOrders(orders) {
  fs.writeFileSync(ORDERS_FILE, JSON.stringify(orders, null, 2));
}

app.post('/webhook', express.raw({ type: 'application/json' }), (req, res) => {
  const sig = req.headers['stripe-signature'];
  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
  } catch (err) {
    console.error('Webhook signature verification failed:', err.message);
    return res.status(400).send('Webhook Error: ' + err.message);
  }

  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;
    markOrderPaid(session.id);
  }

  res.json({ received: true });
});

app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

function markOrderPaid(sessionId) {
  const orders = readOrders();
  const order = orders[sessionId];
  if (!order) return null;
  if (order.status !== 'paid') {
    order.status = 'paid';
    order.accessToken = order.accessToken || crypto.randomBytes(24).toString('hex');
    order.paidAt = new Date().toISOString();
    orders[sessionId] = order;
    writeOrders(orders);
  }
  return order;
}

app.get('/api/products', (req, res) => {
  res.json(PRODUCTS.map(({ file, ...pub }) => pub));
});

app.post('/api/create-checkout-session', async (req, res) => {
  try {
    const cart = req.body.cart || {};
    const entries = Object.entries(cart).filter(([, qty]) => qty > 0);
    if (entries.length === 0) {
      return res.status(400).json({ error: 'السلة فاضية' });
    }

    const line_items = entries.map(([id, qty]) => {
      const p = getProduct(id);
      if (!p) throw new Error('منتج غير معروف: ' + id);
      return {
        quantity: qty,
        price_data: {
          currency: 'sar',
          unit_amount: Math.round(p.price * 100),
          product_data: { name: p.name },
        },
      };
    });

    const origin = req.protocol + '://' + req.get('host');

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      line_items,
      success_url: origin + '/success.html?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: origin + '/index.html',
      shipping_address_collection: { allowed_countries: ['SA', 'AE', 'KW', 'QA', 'BH', 'OM'] },
      phone_number_collection: { enabled: true },
    });

    const orders = readOrders();
    orders[session.id] = {
      status: 'pending',
      items: entries.map(([id, qty]) => ({ id: Number(id), qty })),
      createdAt: new Date().toISOString(),
    };
    writeOrders(orders);

    res.json({ url: session.url });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/api/verify-session', async (req, res) => {
  try {
    const { session_id } = req.query;
    if (!session_id) return res.status(400).json({ error: 'missing session_id' });

    const session = await stripe.checkout.sessions.retrieve(session_id);
    let order;
    if (session.payment_status === 'paid') {
      order = markOrderPaid(session_id);
    } else {
      const orders = readOrders();
      order = orders[session_id];
    }

    if (!order) return res.status(404).json({ error: 'order not found' });

    res.json({
      paid: order.status === 'paid',
      token: order.status === 'paid' ? order.accessToken : null,
      items: order.items.map(({ id, qty }) => {
        const { file, ...pub } = getProduct(id);
        return { ...pub, qty };
      }),
    });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});

app.get('/library/:token/:productId', (req, res) => {
  const { token, productId } = req.params;
  const orders = readOrders();
  const order = Object.values(orders).find(o => o.status === 'paid' && o.accessToken === token);

  if (!order) return res.status(403).send('رابط غير صالح أو الطلب لم يتم دفعه بعد.');

  const owns = order.items.some(i => i.id === Number(productId));
  const product = getProduct(productId);
  if (!owns || !product || !product.digital) {
    return res.status(403).send('هذا المنتج غير مشمول بهذا الطلب.');
  }

  const filePath = path.join(FILES_DIR, product.file);
  if (!fs.existsSync(filePath)) return res.status(404).send('الملف غير موجود على السيرفر.');

  res.setHeader('Content-Disposition', 'inline; filename="' + encodeURIComponent(product.file) + '"');
  res.sendFile(filePath);
});

app.listen(PORT, () => {
  console.log('✅ Store running: http://localhost:' + PORT);
});

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import Razorpay from 'razorpay';
import { initializeApp } from 'firebase/app';
import { getFirestore, doc, onSnapshot } from 'firebase/firestore';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Security Middlewares (OWASP Top 10 protection)
app.use(helmet()); // Sets secure HTTP headers to prevent standard vulnerabilities

// Configure CORS
const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'https://coreblock.in',
  'https://www.coreblock.in',
  process.env.FRONTEND_URL
].filter((origin): origin is string => !!origin);

app.use(cors({
  origin: (origin, callback) => {
    // Allow requests with no origin (like mobile apps, ESP32, curl)
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }
    return callback(new Error('CORS Policy: Origin not allowed by security headers'), false);
  },
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Global Rate Limiter to prevent DOS/Brute-force attacks
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 200, // Limit each IP to 200 requests per windowMs
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please try again later.' }
});

// Apply rate limiting to transactional payment endpoints
const paymentLimiter = rateLimit({
  windowMs: 1 * 60 * 1000, // 1 minute
  max: 30, // Limit each IP to 30 payment requests per minute
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Rate limit exceeded. Too many requests to payment API.' }
});

app.use('/api/', globalLimiter);
app.use('/api/payment/', paymentLimiter);

// Critical crash prevention loggers
process.on('unhandledRejection', (reason, promise) => {
  console.error('CRITICAL: Unhandled Rejection at:', promise, 'reason:', reason);
});

process.on('uncaughtException', (err) => {
  console.error('CRITICAL: Uncaught Exception thrown:', err);
});

// Razorpay Instance Setup
const razorpay = new Razorpay({
  key_id: process.env.RAZORPAY_KEY_ID || 'rzp_live_TGx9X5Tby0KVB8',
  key_secret: process.env.RAZORPAY_KEY_SECRET || '9GizZR3GFrYMhKAwWESLSBnn'
});

// Firebase Configuration & Firestore sync
const firebaseConfig = {
  apiKey: process.env.FIREBASE_API_KEY,
  authDomain: process.env.FIREBASE_AUTH_DOMAIN,
  projectId: process.env.FIREBASE_PROJECT_ID,
  storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
  messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
  appId: process.env.FIREBASE_APP_ID,
  measurementId: process.env.FIREBASE_MEASUREMENT_ID
};

// Initialize Firebase if config is present
let currentAmount = Number(process.env.QR_AMOUNT) || 50;
let currentPaymentLink: any = null;

if (firebaseConfig.apiKey && firebaseConfig.projectId) {
  try {
    const firebaseApp = initializeApp(firebaseConfig);
    const db = getFirestore(firebaseApp);

    // Synchronize price configurations in real-time from Firestore doc /config/kiosk
    onSnapshot(doc(db, "config", "kiosk"), (snapshot) => {
      if (snapshot.exists()) {
        const data = snapshot.data();
        if (data && data.amount) {
          currentAmount = Number(data.amount);
          currentPaymentLink = null; // Invalidate cached payment links immediately when price changes
          console.log(`[FIRESTORE] Real-time price sync: active amount is now INR ${currentAmount}. Cache reset.`);
        }
      }
    }, (error) => {
      console.error('[FIRESTORE] Sync listener failed:', error);
    });
  } catch (err: any) {
    console.error('[FIRESTORE] Failed to initialize Firebase Real-time Sync:', err.message);
  }
} else {
  console.warn('[FIRESTORE] Missing Firebase environment variables. Running in in-memory mode.');
}

// -------------------------------------------------------------
// ENDPOINTS
// -------------------------------------------------------------

// Root Status
app.get('/', (req: Request, res: Response) => {
  res.json({ status: 'active', version: '2.0.0', service: 'FreshPod Secure Payment API' });
});

// Dynamic Firebase client config fetch (useful for dynamic frontend bindings)
app.get('/api/firebase-config', (req: Request, res: Response) => {
  res.json({
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID,
    measurementId: process.env.FIREBASE_MEASUREMENT_ID
  });
});

// Fetch recent transaction logs for the dashboard
app.get('/api/payments/all', async (req: Request, res: Response) => {
  try {
    const response = await razorpay.payments.all({ count: 100 });
    res.json(response.items || []);
  } catch (error: any) {
    console.error('Failed to query payments:', error.message || error);
    res.status(500).json({ error: 'Failed to retrieve transaction logs' });
  }
});

// CSV Export Endpoint for Excel download
app.get('/api/payments/export', async (req: Request, res: Response) => {
  try {
    const response = await razorpay.payments.all({ count: 100 });
    const payments = response.items || [];
    
    let csv = 'Payment ID,Date,Amount (INR),Method,Status,Customer Email,Customer Contact\n';
    payments.forEach((p: any) => {
      const date = new Date(p.created_at * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      const amount = (p.amount / 100).toFixed(2);
      const email = p.email || 'N/A';
      const contact = p.contact || 'N/A';
      csv += `"${p.id}","${date}",${amount},"${p.method}","${p.status}","${email}","${contact}"\n`;
    });
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=freshpod_payments.csv');
    res.send(csv);
  } catch (error: any) {
    console.error('Export error:', error.message || error);
    res.status(500).send('Export failed');
  }
});

// Create/Fetch cached Razorpay payment link for ESP32
app.post('/api/payment/create', async (req: Request, res: Response) => {
  try {
    const machineId = req.body.machine_id || 'FP_MACHINE_01';

    // Verify status of cached link
    if (currentPaymentLink) {
      try {
        const statusCheck: any = await razorpay.paymentLink.fetch(currentPaymentLink.id);
        if (['paid', 'cancelled', 'expired'].includes(statusCheck.status)) {
          currentPaymentLink = null;
        }
      } catch (err: any) {
        currentPaymentLink = null;
      }
    }

    // Generate a fresh link if cache is empty
    if (!currentPaymentLink) {
      const paymentLink = await razorpay.paymentLink.create({
        upi_link: true,
        amount: Math.round(currentAmount * 100), // convert to paise
        currency: 'INR',
        accept_partial: false,
        description: `FreshPod Payment - Machine ${machineId}`,
        customer: {
          name: 'FreshPod User',
          email: 'support@coreblock.in',
          contact: '+919032185199'
        },
        notify: {
          sms: false,
          email: false
        },
        reminder_enable: false,
        notes: {
          machine_id: machineId
        }
      });
      currentPaymentLink = paymentLink;
    }

    res.json({
      qr_id: currentPaymentLink.id,
      upi_intent: currentPaymentLink.short_url,
      amount: currentAmount
    });
  } catch (error: any) {
    console.error('[API] Failed to resolve payment link:', error.message || error);
    res.status(502).json({ error: 'Failed to create payment link' });
  }
});

// Poll payment status directly from Razorpay (stateless polling)
app.get('/api/payment/status', async (req: Request, res: Response) => {
  const { qr_id } = req.query;

  if (!qr_id || typeof qr_id !== 'string' || qr_id === 'static_link') {
    return res.json({ qr_id, status: 'pending' });
  }

  try {
    const paymentLink: any = await razorpay.paymentLink.fetch(qr_id);
    const isPaid = paymentLink.status === 'paid';

    if (isPaid) {
      if (currentPaymentLink && currentPaymentLink.id === qr_id) {
        currentPaymentLink = null; // Reset cache immediately
      }
    }

    res.json({
      qr_id,
      status: isPaid ? 'paid' : 'pending'
    });
  } catch (error: any) {
    console.error(`[API] Error checking status for ID ${qr_id}:`, error.message || error);
    res.status(500).json({ error: 'Failed to fetch status from Razorpay' });
  }
});

// Custom error handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('Fatal Server Error:', err.stack);
  res.status(500).json({ error: 'Internal Server Error' });
});

app.listen(PORT, () => {
  console.log(`[INFO] TS Backend running on port ${PORT}`);
});

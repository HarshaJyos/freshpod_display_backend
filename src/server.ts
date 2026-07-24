import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import Razorpay from 'razorpay';
import { initializeApp, cert } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import dotenv from 'dotenv';

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3000;

// Initialize Firebase Admin SDK
if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  try {
    const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
    initializeApp({
      credential: cert(serviceAccount)
    });
    console.log('[FIREBASE] Admin SDK initialized using Service Account JSON.');
  } catch (err: any) {
    console.error('[FIREBASE] Error parsing Service Account JSON:', err.message);
    initializeApp();
  }
} else {
  try {
    initializeApp();
    console.log('[FIREBASE] Admin SDK initialized using Default Credentials.');
  } catch (err: any) {
    // If not initialized, fallback to project ID locally
    try {
      initializeApp({ projectId: process.env.FIREBASE_PROJECT_ID || 'freshpod-901ed' });
      console.log('[FIREBASE] Admin SDK initialized using Project ID fallback.');
    } catch (fallbackErr: any) {
      console.error('[FIREBASE] Critical: Admin SDK failed to initialize:', fallbackErr.message);
    }
  }
}

const db = getFirestore();
const authAdmin = getAuth();

// Types for SaaS Multi-Tenant Structure
interface UserProfile {
  uid: string;
  email: string;
  role: 'admin' | 'vendor';
  machineId?: string;
  location?: string;
  createdAt: number;
}

interface MachineConfig {
  machineId: string;
  vendorUid: string;
  location: string;
  amount: number;
  razorpayKeyId?: string;
  razorpayKeySecret?: string;
  updatedAt: number;
}

interface AuthenticatedRequest extends Request {
  user?: UserProfile;
}

// Global states for caching current active payment links per machine
const linkCache = new Map<string, { id: string; short_url: string; amount: number; machineId: string }>();

// Security Middlewares (OWASP Top 10)
app.use(helmet());

const allowedOrigins = [
  'http://localhost:3000',
  'http://localhost:3001',
  'https://coreblock.in',
  'https://www.coreblock.in',
  process.env.FRONTEND_URL
].filter((origin): origin is string => !!origin);

app.use(cors({
  origin: (origin, callback) => {
    if (!origin) return callback(null, true);
    if (allowedOrigins.indexOf(origin) !== -1 || process.env.NODE_ENV !== 'production') {
      return callback(null, true);
    }
    return callback(new Error('CORS Policy Violation: Origin not allowed'), false);
  },
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate Limiters
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 200,
  message: { error: 'Too many requests, try again later.' }
});
app.use('/api/', apiLimiter);

// Auth Token Verification Middleware
const requireAuth = async (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Authorization header missing or invalid' });
  }

  const token = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await authAdmin.verifyIdToken(token);
    const { uid, email } = decodedToken;

    // Fetch user profile from Firestore
    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) {
      return res.status(403).json({ error: 'User profile not synchronized' });
    }

    const userData = userDoc.data() as Omit<UserProfile, 'uid'>;
    req.user = {
      uid,
      email: email || userData.email,
      role: userData.role,
      machineId: userData.machineId,
      location: userData.location,
      createdAt: userData.createdAt
    };

    next();
  } catch (err: any) {
    console.error('[AUTH] Token verification failed:', err.message);
    res.status(401).json({ error: 'Unauthorized credentials' });
  }
};

// Admin Only Guard Middleware
const requireAdmin = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden: Admin access required' });
  }
  next();
};

// Dynamic Razorpay Instance Resolver based on Machine config
const getRazorpayInstance = async (machineId: string): Promise<{ instance: Razorpay; config: MachineConfig }> => {
  let config: MachineConfig = {
    machineId,
    vendorUid: '',
    location: 'Fallback Default',
    amount: Number(process.env.QR_AMOUNT) || 50,
    razorpayKeyId: process.env.RAZORPAY_KEY_ID,
    razorpayKeySecret: process.env.RAZORPAY_KEY_SECRET,
    updatedAt: Date.now()
  };

  try {
    const machineDoc = await db.collection('machines').doc(machineId).get();
    if (machineDoc.exists) {
      const data = machineDoc.data() as Omit<MachineConfig, 'machineId'>;
      config = {
        machineId,
        ...data
      };
    }
  } catch (err: any) {
    console.error(`[DB] Error fetching machine config for ${machineId}:`, err.message);
  }

  const keyId = config.razorpayKeyId || process.env.RAZORPAY_KEY_ID || 'rzp_live_TGx9X5Tby0KVB8';
  const keySecret = config.razorpayKeySecret || process.env.RAZORPAY_KEY_SECRET || '9GizZR3GFrYMhKAwWESLSBnn';

  const instance = new Razorpay({
    key_id: keyId,
    key_secret: keySecret
  });

  return { instance, config };
};

// Helper: Query payments for a specific machine's credentials
const getPaymentsForMachine = async (machineId: string): Promise<any[]> => {
  try {
    const { instance } = await getRazorpayInstance(machineId);
    const response = await instance.payments.all({ count: 100 });
    return (response.items || []).map((p: any) => ({
      ...p,
      machineId // Tag transaction with the machine it belongs to
    }));
  } catch (err: any) {
    console.error(`[PAYMENT] Error fetching payments for machine ${machineId}:`, err.message);
    return [];
  }
};

// -------------------------------------------------------------
// ENDPOINTS
// -------------------------------------------------------------

// Root Status
app.get('/', (req: Request, res: Response) => {
  res.json({ status: 'active', version: '2.1.0', service: 'FreshPod Dynamic Multi-Tenant API' });
});

// Dynamic Firebase client config fetch
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

// Auth sync: Bootstrapping Admin and linking registered vendor emails
app.post('/api/auth/sync', async (req: Request, res: Response) => {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'Auth token missing' });
  }

  const token = authHeader.split('Bearer ')[1];
  try {
    const decodedToken = await authAdmin.verifyIdToken(token);
    const { uid, email } = decodedToken;

    if (!email) {
      return res.status(400).json({ error: 'Email required' });
    }

    const userDocRef = db.collection('users').doc(uid);
    let userDoc = await userDocRef.get();

    if (!userDoc.exists) {
      // 1. Check if this is the first user in the system
      const usersSnap = await db.collection('users').limit(1).get();
      if (usersSnap.empty) {
        // First login -> Auto-bootstrap as Admin
        const newAdmin: UserProfile = {
          uid,
          email,
          role: 'admin',
          createdAt: Date.now()
        };
        await userDocRef.set(newAdmin);
        console.log(`[BOOTSTRAP] Successfully registered first user ${email} as Admin.`);
        return res.json(newAdmin);
      }

      // 2. Check if this email was pre-registered by the admin
      const placeholderDocRef = db.collection('users').doc(email.toLowerCase());
      const placeholderDoc = await placeholderDocRef.get();

      if (placeholderDoc.exists) {
        const placeholderData = placeholderDoc.data() as Omit<UserProfile, 'uid'>;
        
        // Link placeholder data to the new UID doc
        const linkedVendor: UserProfile = {
          uid,
          email,
          role: placeholderData.role,
          machineId: placeholderData.machineId,
          location: placeholderData.location,
          createdAt: Date.now()
        };

        await userDocRef.set(linkedVendor);
        await placeholderDocRef.delete(); // Delete email placeholder
        console.log(`[AUTH] Linked pre-registered vendor email ${email} to UID ${uid}`);
        return res.json(linkedVendor);
      }

      // Block unregistered registrations
      return res.status(403).json({ error: 'Registration restricted. Admin registration required.' });
    }

    res.json({ uid, ...userDoc.data() });
  } catch (err: any) {
    console.error('[AUTH] Sync error:', err.message);
    res.status(500).json({ error: 'Internal Auth Sync Error' });
  }
});

// Admin-only: Register new vendor placeholder configurations
app.post('/api/admin/vendors', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { email, machineId, location, amount, razorpayKeyId, razorpayKeySecret } = req.body;

  if (!email || !machineId || !location || !amount) {
    return res.status(400).json({ error: 'Missing required configuration fields' });
  }

  try {
    const formattedEmail = email.toLowerCase().trim();

    // 1. Check if email or machine is already registered
    const emailCheck = await db.collection('users').doc(formattedEmail).get();
    if (emailCheck.exists) return res.status(400).json({ error: 'Email already pre-registered' });

    const machineCheck = await db.collection('machines').doc(machineId).get();
    if (machineCheck.exists) return res.status(400).json({ error: 'Machine ID already registered to a vendor' });

    // 2. Write User profile placeholder keyed by email
    const userPlaceholder = {
      email: formattedEmail,
      role: 'vendor',
      machineId,
      location,
      createdAt: Date.now()
    };
    await db.collection('users').doc(formattedEmail).set(userPlaceholder);

    // 3. Write Machine configuration
    const machineConfig: MachineConfig = {
      machineId,
      vendorUid: '', // Will link when vendor logs in
      location,
      amount: Number(amount),
      razorpayKeyId: razorpayKeyId || '',
      razorpayKeySecret: razorpayKeySecret || '',
      updatedAt: Date.now()
    };
    await db.collection('machines').doc(machineId).set(machineConfig);

    res.json({ message: 'Vendor pre-registered successfully', userPlaceholder, machineConfig });
  } catch (err: any) {
    console.error('[ADMIN] Vendor registration error:', err.message);
    res.status(500).json({ error: 'Failed to pre-register vendor' });
  }
});

// Create cached Payment Link for ESP32 (Resolves keys dynamically)
app.post('/api/payment/create', async (req: Request, res: Response) => {
  const { machine_id } = req.body;
  const targetMachine = machine_id || 'FP_MACHINE_01';

  try {
    const { instance, config } = await getRazorpayInstance(targetMachine);
    let cached = linkCache.get(targetMachine);

    // Validate cache status
    if (cached) {
      try {
        const check: any = await instance.paymentLink.fetch(cached.id);
        if (['paid', 'cancelled', 'expired'].includes(check.status)) {
          linkCache.delete(targetMachine);
          cached = undefined;
        }
      } catch (err) {
        linkCache.delete(targetMachine);
        cached = undefined;
      }
    }

    if (!cached) {
      console.log(`[PAYMENT] Creating payment link for Machine ${targetMachine} at amount INR ${config.amount}`);
      const link = await instance.paymentLink.create({
        upi_link: true,
        amount: Math.round(config.amount * 100),
        currency: 'INR',
        accept_partial: false,
        description: `FreshPod Payment - Machine ${targetMachine}`,
        customer: {
          name: 'FreshPod User',
          email: 'support@coreblock.in',
          contact: '+919032185199'
        },
        notify: { sms: false, email: false },
        reminder_enable: false,
        notes: { machine_id: targetMachine }
      });

      cached = {
        id: link.id,
        short_url: link.short_url,
        amount: config.amount,
        machineId: targetMachine
      };
      linkCache.set(targetMachine, cached);
    }

    res.json({
      qr_id: cached.id,
      upi_intent: cached.short_url,
      amount: cached.amount
    });
  } catch (error: any) {
    console.error(`[API] Failed to create payment for ${targetMachine}:`, error.message || error);
    res.status(502).json({ error: 'Failed to create payment link' });
  }
});

// Fetch payment status (Supports direct query & cache mapping check)
app.get('/api/payment/status', async (req: Request, res: Response) => {
  const { qr_id, machine_id } = req.query;

  if (!qr_id || typeof qr_id !== 'string' || qr_id === 'static_link') {
    return res.json({ qr_id, status: 'pending' });
  }

  // 1. Resolve which machine this payment link belongs to
  let targetMachine = typeof machine_id === 'string' ? machine_id : '';
  if (!targetMachine) {
    // Check our link cache memory
    for (const [mId, cached] of linkCache.entries()) {
      if (cached.id === qr_id) {
        targetMachine = mId;
        break;
      }
    }
  }

  try {
    const { instance } = await getRazorpayInstance(targetMachine || 'FP_MACHINE_01');
    const paymentLink: any = await instance.paymentLink.fetch(qr_id);
    const isPaid = paymentLink.status === 'paid';

    if (isPaid && targetMachine) {
      linkCache.delete(targetMachine); // Clean cache immediately
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

// Retrieve aggregated transactions for dashboard (Admin fetches all, Vendor fetches their own)
app.get('/api/payments/all', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  if (!req.user) return res.status(401).json({ error: 'Unauthenticated' });

  try {
    if (req.user.role === 'admin') {
      // 1. Admin reads all registered machines
      const machinesSnap = await db.collection('machines').get();
      const allPaymentsPromises = machinesSnap.docs.map((doc: any) => getPaymentsForMachine(doc.id));
      
      const results = await Promise.all(allPaymentsPromises);
      let aggregatedPayments = results.reduce((acc: any[], val: any[]) => acc.concat(val), []);

      // Sort by creation time descending
      aggregatedPayments.sort((a: any, b: any) => b.created_at - a.created_at);
      return res.json(aggregatedPayments);
    } else {
      // 2. Vendor reads only their assigned machine
      const mId = req.user.machineId;
      if (!mId) return res.json([]);
      const payments = await getPaymentsForMachine(mId);
      return res.json(payments);
    }
  } catch (err: any) {
    console.error('[API] Error retrieving dashboard payments:', err.message);
    res.status(500).json({ error: 'Failed to retrieve transactions' });
  }
});

// CSV Export Endpoint for Excel download
app.get('/api/payments/export', async (req: Request, res: Response) => {
  // Direct download link. Verify user via query parameter token if needed, or default to all machines
  try {
    const machinesSnap = await db.collection('machines').get();
    const allPaymentsPromises = machinesSnap.docs.map((doc: any) => getPaymentsForMachine(doc.id));
    
    const results = await Promise.all(allPaymentsPromises);
    let aggregatedPayments = results.reduce((acc: any[], val: any[]) => acc.concat(val), []);
    aggregatedPayments.sort((a: any, b: any) => b.created_at - a.created_at);
    
    let csv = 'Payment ID,Machine ID,Date,Amount (INR),Method,Status,Customer Email,Customer Contact\n';
    aggregatedPayments.forEach((p: any) => {
      const date = new Date(p.created_at * 1000).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' });
      const amount = (p.amount / 100).toFixed(2);
      const email = p.email || 'N/A';
      const contact = p.contact || 'N/A';
      const mId = p.machineId || 'N/A';
      csv += `"${p.id}","${mId}","${date}",${amount},"${p.method}","${p.status}","${email}","${contact}"\n`;
    });
    
    res.setHeader('Content-Type', 'text/csv');
    res.setHeader('Content-Disposition', 'attachment; filename=freshpod_payments.csv');
    res.send(csv);
  } catch (error: any) {
    console.error('Export error:', error.message || error);
    res.status(500).send('Export failed');
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

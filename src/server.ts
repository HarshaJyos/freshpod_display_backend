import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import Razorpay from 'razorpay';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';
import dotenv from 'dotenv';

// Import Mongoose DB connect and sync utilities
import connectDB from './db/connect';
import startSync from './init/sync';
import SanitizationRefill from './Model/SantizationLiquid';
import Machine from './Model/machineSchema';
import User from './Model/userSchema';
import mqttService from './services/mqttService';

import userRoute from './routes/userRoute';
import adminRoute from './routes/adminRoutes';
import dealershipRoute from './routes/dealershipRoute';
import customerRoute from './routes/customerRoutes';
import operatorRoutes from './routes/operatorRoutes';
import mongoose from 'mongoose';

dotenv.config();

const app = express();

// Initialize MQTT Connection
mqttService.connect();
app.set('mqttClient', mqttService.client);
const PORT = process.env.PORT || 3000;

// Initialize Firebase Admin SDK
if (getApps().length === 0) {
  if (process.env.FIREBASE_SERVICE_ACCOUNT) {
    try {
      const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
      if (serviceAccount.private_key) {
        serviceAccount.private_key = serviceAccount.private_key.replace(/\\n/g, '\n');
      }
      initializeApp({
        credential: cert(serviceAccount),
        databaseURL: 'https://freshpod-901ed-default-rtdb.asia-southeast1.firebasedatabase.app'
      });
      console.log('[FIREBASE] Admin SDK initialized using Service Account JSON.');
    } catch (err: any) {
      console.error('[FIREBASE] Error parsing Service Account JSON:', err.message);
      try {
        initializeApp({
          databaseURL: 'https://freshpod-901ed-default-rtdb.asia-southeast1.firebasedatabase.app'
        });
      } catch (fallbackErr: any) {
        console.error('[FIREBASE] Fallback ADC failed:', fallbackErr.message);
        initializeApp({
          projectId: process.env.FIREBASE_PROJECT_ID || 'freshpod-901ed',
          databaseURL: 'https://freshpod-901ed-default-rtdb.asia-southeast1.firebasedatabase.app'
        });
      }
    }
  } else {
    try {
      initializeApp({
        databaseURL: 'https://freshpod-901ed-default-rtdb.asia-southeast1.firebasedatabase.app'
      });
      console.log('[FIREBASE] Admin SDK initialized using Default Credentials.');
    } catch (err: any) {
      // If not initialized, fallback to project ID locally
      try {
        initializeApp({
          projectId: process.env.FIREBASE_PROJECT_ID || 'freshpod-901ed',
          databaseURL: 'https://freshpod-901ed-default-rtdb.asia-southeast1.firebasedatabase.app'
        });
        console.log('[FIREBASE] Admin SDK initialized using Project ID fallback.');
      } catch (fallbackErr: any) {
        console.error('[FIREBASE] Critical: Admin SDK failed to initialize:', fallbackErr.message);
      }
    }
  }
}

// Connect to MongoDB and start Firebase RTDB sync
connectDB();
startSync();

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
    // Allow all origins dynamically to support credentials and prevent CORS errors
    callback(null, true);
  },
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate Limiters
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000, // Increased for production-grade load tolerance
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
// Dynamic Razorpay Instance Resolver based on Machine config
const getRazorpayInstance = async (machineId: string): Promise<{ instance: Razorpay; config: MachineConfig }> => {
  let config: MachineConfig = {
    machineId,
    vendorUid: '',
    location: 'Fallback Default',
    amount: Number(process.env.QR_AMOUNT) || 50,
    razorpayKeyId: '',
    razorpayKeySecret: '',
    updatedAt: Date.now()
  };

  let resolvedUserId: string | null = null;
  let resolvedUserKeyId: string = '';
  let resolvedUserKeySecret: string = '';
  let actualMachineId = machineId;

  // 1. QUERY MONGODB MACHINE & USER COLLECTIONS FIRST
  try {
    const MachineModel = mongoose.models.Machine || mongoose.model('Machine');
    let query: any = { machineId };
    if (mongoose.Types.ObjectId.isValid(machineId)) {
      query = { $or: [{ _id: machineId }, { machineId }] };
    }
    const mongoMachine = await MachineModel.findOne(query);
    if (mongoMachine) {
      actualMachineId = mongoMachine.machineId; // Resolve original machineId string!
      config.machineId = actualMachineId;

      // Find who the machine is assigned to in MongoDB
      const userId = mongoMachine.assignedTo || mongoMachine.dealership || mongoMachine.operatorId;
      if (userId) {
        const mongoUser = await User.findById(userId);
        if (mongoUser) {
          resolvedUserId = mongoUser._id.toString();
          resolvedUserKeyId = mongoUser.razorpayKeyId || '';
          resolvedUserKeySecret = mongoUser.razorpayKeySecret || '';
        }
      }

      // Also get machine-level fallback keys from MongoDB machine doc if present
      config.razorpayKeyId = mongoMachine.razorpayKeyId || config.razorpayKeyId;
      config.razorpayKeySecret = mongoMachine.razorpayKeySecret || config.razorpayKeySecret;
      config.amount = mongoMachine.costPerTap || config.amount;
      config.location = mongoMachine.location || config.location;
    }
  } catch (err: any) {
    console.error(`[DB] Error fetching MongoDB machine config for ${machineId}:`, err.message);
  }

  // 2. QUERY FIREBASE FIRESTORE AS A FALLBACK/SUPPLEMENT
  try {
    const machineDoc = await db.collection('machines').doc(actualMachineId).get();
    if (machineDoc.exists) {
      const data = machineDoc.data();
      if (data) {
        config.vendorUid = data.vendorUid || config.vendorUid;
        config.amount = data.amount !== undefined ? Number(data.amount) : config.amount;
        config.location = data.location || config.location;

        // Machine-level keys fallback from Firestore machine doc
        config.razorpayKeyId = data.razorpayKeyId || config.razorpayKeyId;
        config.razorpayKeySecret = data.razorpayKeySecret || config.razorpayKeySecret;

        // If we haven't resolved a MongoDB user yet, resolve using Firestore's vendorUid
        if (!resolvedUserKeyId && config.vendorUid) {
          let firebaseLinkedUser = await User.findById(config.vendorUid);
          if (!firebaseLinkedUser) {
            firebaseLinkedUser = await User.findOne({
              $or: [
                { _id: config.vendorUid },
                { email: config.vendorUid }
              ]
            });
          }

          if (firebaseLinkedUser) {
            resolvedUserKeyId = firebaseLinkedUser.razorpayKeyId || '';
            resolvedUserKeySecret = firebaseLinkedUser.razorpayKeySecret || '';
          }
        }
      }
    }
  } catch (err: any) {
    console.error(`[DB] Error fetching Firestore machine config for ${actualMachineId}:`, err.message);
  }

  // 3. APPLY RESOLUTION PRIORITY
  // First priority: Assigned User's Razorpay credentials
  let finalKeyId = resolvedUserKeyId;
  let finalKeySecret = resolvedUserKeySecret;

  // Second priority: Machine-level Razorpay credentials
  if (!finalKeyId) {
    finalKeyId = config.razorpayKeyId;
    finalKeySecret = config.razorpayKeySecret;
    if (finalKeyId) {
      console.log(`[PAYMENT] Falling back to Machine-level credentials for machine ${actualMachineId}`);
    }
  } else {
    console.log(`[PAYMENT] Resolved Razorpay credentials from assigned User for machine ${actualMachineId}`);
  }

  // Third priority (Fallback): Global System Env parameters
  if (!finalKeyId) {
    finalKeyId = process.env.RAZORPAY_KEY_ID || 'rzp_live_TGx9X5Tby0KVB8';
    finalKeySecret = process.env.RAZORPAY_KEY_SECRET || '9GizZR3GFrYMhKAwWESLSBnn';
    console.log(`[PAYMENT] Falling back to Global System Env credentials for machine ${actualMachineId}`);
  }

  // Update config back with the resolved keys
  config.razorpayKeyId = finalKeyId;
  config.razorpayKeySecret = finalKeySecret;

  const instance = new Razorpay({
    key_id: finalKeyId,
    key_secret: finalKeySecret
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

// Create payment link via Razorpay
app.post('/api/payment/create', async (req: Request, res: Response) => {
  try {
    const { machine_id } = req.body;
    if (!machine_id) {
      return res.status(400).json({ error: 'machine_id parameter is required' });
    }

    const { instance, config } = await getRazorpayInstance(machine_id);
    const resolvedMachineId = config.machineId; // Guaranteed to be the original machineId string!
    const amountInPaise = Math.round(config.amount * 100);

    // 1. Check Cache first
    const cachedLink = linkCache.get(resolvedMachineId);
    if (cachedLink && cachedLink.amount === amountInPaise) {
      console.log(`[PAYMENT] Reusing cached active payment link for machine ${resolvedMachineId}`);
      return res.json({
        upi_intent: cachedLink.short_url,
        qr_id: cachedLink.id
      });
    }

    // 2. Generate a new payment link via Razorpay API
    console.log(`[PAYMENT] Creating new payment link of ${config.amount} INR for machine ${resolvedMachineId}`);
    const paymentLink = await instance.paymentLink.create({
      amount: amountInPaise,
      currency: 'INR',
      accept_partial: false,
      description: `Payment for FreshPod Kiosk`,
      customer: {
        name: 'FreshPod Customer'
      },
      notify: {
        sms: false,
        email: false
      },
      reminder_enable: false,
      notes: {
        machine_id: resolvedMachineId
      }
    });

    // 3. Store active link config to cache
    linkCache.set(resolvedMachineId, {
      id: paymentLink.id,
      short_url: paymentLink.short_url,
      amount: amountInPaise,
      machineId: resolvedMachineId
    });

    return res.json({
      upi_intent: paymentLink.short_url,
      qr_id: paymentLink.id
    });
  } catch (error: any) {
    console.error(`[API] Failed to create payment:`, error);
    const details = error.description || error.message || (error.error && error.error.description) || JSON.stringify(error);
    return res.status(502).json({ error: 'Failed to create payment link', details });
  }
});

// Verify payment status
app.get('/api/payment/status', async (req: Request, res: Response) => {
  const qr_id = req.query.qr_id as string;

  if (!qr_id) {
    return res.status(400).json({ error: 'qr_id parameter is required' });
  }

  // 1. Locate machine ID from the cached payment link
  let machineId = 'default';
  for (const [mId, cached] of linkCache.entries()) {
    if (cached.id === qr_id) {
      machineId = mId;
      break;
    }
  }

  try {
    const { instance } = await getRazorpayInstance(machineId);

    // 2. Fetch payment link details from Razorpay
    const paymentLink = await instance.paymentLink.fetch(qr_id);

    // Status mapping: 'created' (pending), 'paid' (paid), 'expired' / 'cancelled' (failed)
    let status = 'pending';
    if (paymentLink.status === 'paid') {
      status = 'paid';
      // Clean up cache once transaction is paid
      if (machineId !== 'default') {
        linkCache.delete(machineId);
      }
    } else if (paymentLink.status === 'expired' || paymentLink.status === 'cancelled') {
      status = 'failed';
    }

    return res.json({ qr_id, status });
  } catch (error: any) {
    console.error(`[API] Failed to verify payment status:`, error);
    const details = error.description || error.message || (error.error && error.error.description) || JSON.stringify(error);
    return res.status(502).json({ error: 'Failed to verify payment status', details });
  }
});

// Cache for payments listings to prevent rate limits
const paymentsCache = new Map<string, { data: any[]; expiresAt: number }>();
const PAYMENTS_CACHE_TTL = 60000; // 60 seconds TTL

// Get all payments or payments for a specific machine ID
app.get('/api/payments/all', requireAuth, async (req: AuthenticatedRequest, res: Response) => {
  const machineId = req.query.machineId as string;

  try {
    if (!machineId || machineId === 'all') {
      // 1. Get all machines from Firestore
      const machinesSnap = await db.collection('machines').get();
      const machineIds = machinesSnap.docs.map(doc => doc.id);

      // 2. Fetch payments for each machine (uses individual caches)
      const promises = machineIds.map(async (mId) => {
        const cacheKey = `payments_${mId}`;
        const now = Date.now();
        const cached = paymentsCache.get(cacheKey);

        if (cached && cached.expiresAt > now) {
          return cached.data;
        }

        const payments = await getPaymentsForMachine(mId);
        paymentsCache.set(cacheKey, {
          data: payments,
          expiresAt: now + PAYMENTS_CACHE_TTL
        });
        return payments;
      });

      const results = await Promise.all(promises);
      const aggregated = results.reduce((acc, val) => acc.concat(val), []);
      aggregated.sort((a: any, b: any) => b.created_at - a.created_at);

      return res.json(aggregated);
    } else {
      // Fetch for a single machine
      const cacheKey = `payments_${machineId}`;
      const now = Date.now();
      const cached = paymentsCache.get(cacheKey);

      if (cached && cached.expiresAt > now) {
        return res.json(cached.data);
      }

      const payments = await getPaymentsForMachine(machineId);
      paymentsCache.set(cacheKey, {
        data: payments,
        expiresAt: now + PAYMENTS_CACHE_TTL
      });

      return res.json(payments);
    }
  } catch (err: any) {
    console.error('Error fetching payments:', err.message);
    res.status(500).json({ error: 'Failed to fetch payments', details: err.message });
  }
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

// Refill API endpoints from legacy dashboard
app.get('/api/refill/:machineId/start-tapcount', async (req: Request, res: Response) => {
  try {
    const { machineId } = req.params;
    console.log('📥 GET start-tapcount for:', machineId);

    if (!machineId) {
      return res.status(400).json({
        success: false,
        message: 'Machine ID is required'
      });
    }

    const machine = await Machine.findOne({ machineId: machineId });
    if (!machine) {
      return res.status(404).json({
        success: false,
        message: `Machine with ID "${machineId}" not found`
      });
    }

    const refill = await SanitizationRefill.findOne({ machineId: machineId });

    if (!refill) {
      return res.status(200).json({
        success: false,
        message: `No refill record found`,
        data: {
          machineId: machineId,
          startTapCount: 0,
          hasRefill: false,
          containerSize: 5,
          usagePerTap: 0.012,
          totalTaps: machine.totalTaps || 0
        }
      });
    }

    return res.status(200).json({
      success: true,
      data: {
        machineId: refill.machineId,
        startTapCount: refill.tapCountAtRefill || 0,
        refillStartTime: refill.start,
        refillId: refill._id,
        hasRefill: true,
        containerSize: refill.containerSize || 5,
        usagePerTap: refill.usagePerTap || 0.012,
        totalTaps: machine.totalTaps || 0
      }
    });

  } catch (error: any) {
    console.error('❌ Error:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

app.post('/api/refill/:machineId', async (req: Request, res: Response) => {
  try {
    const { machineId } = req.params;
    const { tapCount, containerSize = 5, usagePerTap = 0.012 } = req.body;

    console.log('📝 Refill request:', { machineId, tapCount, containerSize });

    if (!machineId) {
      return res.status(400).json({
        success: false,
        message: 'Machine ID is required'
      });
    }

    if (tapCount === undefined || tapCount === null) {
      return res.status(400).json({
        success: false,
        message: 'Tap count is required'
      });
    }

    const machine = await Machine.findOne({ machineId: machineId });
    if (!machine) {
      return res.status(404).json({
        success: false,
        message: `Machine with ID "${machineId}" not found`
      });
    }

    let refill = await SanitizationRefill.findOne({ machineId: machineId });

    if (refill) {
      refill.tapCountAtRefill = tapCount;
      refill.containerSize = containerSize;
      refill.usagePerTap = usagePerTap;
      refill.start = new Date();
      await refill.save();
      console.log('✅ Refill updated:', machineId);
    } else {
      refill = new SanitizationRefill({
        machineId: machineId,
        tapCountAtRefill: tapCount,
        containerSize: containerSize,
        usagePerTap: usagePerTap,
        start: new Date()
      });
      await refill.save();
      console.log('✅ Refill created:', machineId);
    }

    return res.status(200).json({
      success: true,
      message: 'Refill completed successfully',
      data: {
        machineId: refill.machineId,
        tapCountAtRefill: refill.tapCountAtRefill,
        containerSize: refill.containerSize,
        usagePerTap: refill.usagePerTap,
        start: refill.start,
        refillId: refill._id
      }
    });

  } catch (error: any) {
    console.error('❌ Error starting refill:', error);
    return res.status(500).json({
      success: false,
      message: 'Internal server error',
      error: error.message
    });
  }
});

// Register new vendor directly in Firebase Auth & Firestore, and create machine config
app.post('/api/admin/create-vendor', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { email, password, machineId, location, amount, razorpayKeyId, razorpayKeySecret } = req.body;

  if (!email || !password || !machineId || !location || !amount) {
    return res.status(400).json({ error: 'Missing required configuration fields' });
  }

  const formattedEmail = email.toLowerCase().trim();

  try {
    // 1. Check if machine is already registered in Firestore
    const machineCheck = await db.collection('machines').doc(machineId).get();
    if (machineCheck.exists) {
      return res.status(400).json({ error: 'Machine ID already registered to a vendor' });
    }

    // 2. Create the user in Firebase Authentication
    const userRecord = await authAdmin.createUser({
      email: formattedEmail,
      password: password
    });
    const uid = userRecord.uid;

    // 3. Write User profile in Firestore collection 'users' under uid
    await db.collection('users').doc(uid).set({
      email: formattedEmail,
      role: 'vendor',
      machineId: machineId,
      location: location,
      createdAt: Date.now()
    });

    // 4. Write Machine configuration in Firestore collection 'machines' under machineId
    await db.collection('machines').doc(machineId).set({
      vendorUid: uid,
      location: location,
      amount: Number(amount),
      razorpayKeyId: razorpayKeyId || '',
      razorpayKeySecret: razorpayKeySecret || '',
      updatedAt: Date.now()
    });

    res.status(201).json({
      success: true,
      message: 'Vendor and Kiosk registered successfully',
      vendor: {
        uid,
        email: formattedEmail,
        machineId,
        location
      }
    });
  } catch (err: any) {
    console.error('[API] Error creating vendor:', err.message);
    res.status(500).json({ error: 'Failed to create vendor account', details: err.message });
  }
});

// Delete vendor from Firebase Auth & Firestore, and remove machine config
app.delete('/api/admin/delete-vendor/:uid', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { uid } = req.params;
  const { machineId } = req.query;

  try {
    // 1. Delete user from Firebase Authentication
    try {
      await authAdmin.deleteUser(uid);
      console.log(`[API] Deleted user ${uid} from Firebase Auth`);
    } catch (authErr: any) {
      console.warn(`[API] Failed to delete user ${uid} from Firebase Auth (might not exist):`, authErr.message);
    }

    // 2. Delete user document from Firestore
    await db.collection('users').doc(uid).delete();

    // 3. Delete machine document from Firestore
    if (machineId && typeof machineId === 'string') {
      await db.collection('machines').doc(machineId).delete();
    }

    res.json({ success: true, message: 'Vendor and kiosk configuration deleted successfully' });
  } catch (err: any) {
    console.error('[API] Error deleting vendor:', err.message);
    res.status(500).json({ error: 'Failed to delete vendor', details: err.message });
  }
});

// Mount legacy dashboard routes
app.use('/user', userRoute);
app.use('/admin', adminRoute);
app.use('/dealership', dealershipRoute);
app.use('/customer', customerRoute);
app.use('/operator', operatorRoutes);

// Custom error handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('Fatal Server Error:', err.stack);
  res.status(500).json({ error: 'Internal Server Error' });
});

// Start server locally or in container, but export for Vercel Serverless Functions
if (process.env.NODE_ENV !== 'production' || process.env.PORT) {
  app.listen(PORT, () => {
    console.log(`[INFO] TS Backend running on port ${PORT}`);
  });
}

export default app;

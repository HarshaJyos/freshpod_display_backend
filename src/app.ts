import dns from 'dns';
try {
  dns.setServers(['8.8.8.8', '8.8.4.4']);
  console.log('[DNS] Configured public DNS resolvers for MongoDB connection reliability.');
} catch (err: any) {
  console.warn('[DNS] Failed to set custom DNS resolvers:', err.message);
}

import express, { Request, Response, NextFunction } from 'express';
import cors from 'cors';
import helmet from 'helmet';
import rateLimit from 'express-rate-limit';
import dotenv from 'dotenv';
import mongoose from 'mongoose';
import { initializeApp, cert, getApps } from 'firebase-admin/app';
import { getFirestore } from 'firebase-admin/firestore';
import { getAuth } from 'firebase-admin/auth';

// Database sync utilities
import connectDB from './db/connect';
import startSync from './init/sync';
import mqttService from './services/mqttService';

// Modular routes
import userModuleRouter, { dealershipUserRouter, customerUserRouter } from './modules/user/user.routes';
import { adminMachineRouter, userMachineRouter, refillMachineRouter, operatorMachineRouter, dealershipMachineRouter, customerMachineRouter } from './modules/machine/machine.routes';
import { adminPaymentRouter, apiPaymentRouter } from './modules/payment/payment.routes';
import { adminReportRouter, customerReportRouter } from './modules/report/report.routes';

dotenv.config();

const app = express();

// Initialize MQTT Connection
mqttService.connect();
app.set('mqttClient', mqttService.client);

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

interface UserProfile {
  uid: string;
  email: string;
  role: 'admin' | 'vendor';
  machineId?: string;
  location?: string;
  createdAt: number;
}

interface AuthenticatedRequest extends Request {
  user?: UserProfile;
}

// Security Middlewares (OWASP Top 10)
app.use(helmet());
app.use(cors({
  origin: (origin, callback) => {
    callback(null, true);
  },
  credentials: true
}));

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// Rate Limiters
const apiLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 1000,
  message: { error: 'Too many requests, try again later.' }
});
app.use('/api/', apiLimiter);

const loginLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 15, // Max 15 login attempts per window to prevent brute force
  message: { error: 'Too many login attempts, please try again in 15 minutes.' }
});
app.use('/user/login', loginLimiter);

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

    const userDoc = await db.collection('users').doc(uid).get();
    if (!userDoc.exists) {
      return res.status(403).json({ error: 'User profile not synchronized' });
    }

    const userData = userDoc.data() as UserProfile;
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

const requireAdmin = (req: AuthenticatedRequest, res: Response, next: NextFunction) => {
  if (!req.user || req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Forbidden: Admin access required' });
  }
  next();
};

// Root Status
app.get('/', (req: Request, res: Response) => {
  res.json({ status: 'active', version: '2.1.0', service: 'FreshPod Dynamic Multi-Tenant API' });
});

// Legacy Admin create vendor Firebase Auth
app.post('/api/admin/create-vendor', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { email, password, machineId, location, amount, razorpayKeyId, razorpayKeySecret } = req.body;

  if (!email || !password || !machineId || !location || !amount) {
    return res.status(400).json({ error: 'Missing required configuration fields' });
  }

  const formattedEmail = email.toLowerCase().trim();

  try {
    const machineCheck = await db.collection('machines').doc(machineId).get();
    if (machineCheck.exists) {
      return res.status(400).json({ error: 'Machine ID already registered to a vendor' });
    }

    const userRecord = await authAdmin.createUser({
      email: formattedEmail,
      password: password
    });
    const uid = userRecord.uid;

    await db.collection('users').doc(uid).set({
      email: formattedEmail,
      role: 'vendor',
      machineId: machineId,
      location: location,
      createdAt: Date.now()
    });

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

// Legacy Admin delete vendor Firebase Auth
app.delete('/api/admin/delete-vendor/:uid', requireAuth, requireAdmin, async (req: AuthenticatedRequest, res: Response) => {
  const { uid } = req.params;
  const { machineId } = req.query;

  try {
    try {
      await authAdmin.deleteUser(uid);
      console.log(`[API] Deleted user ${uid} from Firebase Auth`);
    } catch (authErr: any) {
      console.warn(`[API] Failed to delete user ${uid} from Firebase Auth (might not exist):`, authErr.message);
    }

    await db.collection('users').doc(uid).delete();

    if (machineId && typeof machineId === 'string') {
      await db.collection('machines').doc(machineId).delete();
    }

    res.json({ success: true, message: 'Vendor and kiosk configuration deleted successfully' });
  } catch (err: any) {
    console.error('[API] Error deleting vendor:', err.message);
    res.status(500).json({ error: 'Failed to delete vendor', details: err.message });
  }
});

// Mount modular routes
app.use('/user', userModuleRouter);
app.use('/user', userMachineRouter);
app.use('/admin', adminMachineRouter);
app.use('/admin', userModuleRouter);
app.use('/admin', adminPaymentRouter);
app.use('/admin', adminReportRouter);
app.use('/api', apiPaymentRouter);
app.use('/api', refillMachineRouter);

// Mount role-based sub-routers (replacing legacy express routers)
app.use('/operator', operatorMachineRouter);
app.use('/dealership', dealershipUserRouter);
app.use('/dealership', dealershipMachineRouter);
app.use('/customer', customerUserRouter);
app.use('/customer', customerMachineRouter);
app.use('/customer', customerReportRouter);

// Custom error handling middleware
app.use((err: Error, req: Request, res: Response, next: NextFunction) => {
  console.error('Fatal Server Error:', err.stack);
  res.status(500).json({ error: 'Internal Server Error' });
});

export default app;

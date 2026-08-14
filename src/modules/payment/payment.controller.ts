import { Request, Response } from 'express';
import { PaymentService } from './payment.service';
import { Payment } from './payment.model';
import Machine from '../machine/machine.model';
import User from '../user/user.model';
import { getFirestore } from 'firebase-admin/firestore';
import Razorpay from 'razorpay';
import mongoose from 'mongoose';

// Cache to hold active links to avoid rate limits
const linkCache = new Map<string, { id: string; short_url: string; amount: number; machineId: string }>();

interface MachineConfig {
  machineId: string;
  vendorUid: string;
  location: string;
  amount: number;
  razorpayKeyId: string;
  razorpayKeySecret: string;
  updatedAt: number;
}

export class PaymentController {

  /**
   * Helper to resolve the correct multi-tenant Razorpay instance based on machine configuration priority.
   */
  private static async getRazorpayInstance(machineId: string): Promise<{ instance: Razorpay; config: MachineConfig }> {
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

    // 1. Read machine details from MongoDB
    try {
      let query: any = { machineId };
      if (mongoose.Types.ObjectId.isValid(machineId)) {
        query = { $or: [{ _id: machineId }, { machineId }] };
      }
      const mongoMachine = await Machine.findOne(query);
      if (mongoMachine) {
        actualMachineId = mongoMachine.machineId;
        config.machineId = actualMachineId;

        const userId = mongoMachine.assignedTo || mongoMachine.dealership || mongoMachine.operatorId;
        if (userId) {
          const mongoUser = await User.findById(userId);
          if (mongoUser) {
            resolvedUserId = mongoUser._id.toString();
            resolvedUserKeyId = mongoUser.razorpayKeyId || '';
            resolvedUserKeySecret = mongoUser.razorpayKeySecret || '';
          }
        }

        config.razorpayKeyId = mongoMachine.razorpayKeyId || config.razorpayKeyId;
        config.razorpayKeySecret = mongoMachine.razorpayKeySecret || config.razorpayKeySecret;
        config.amount = mongoMachine.costPerTap || config.amount;
        config.location = mongoMachine.location || config.location;
      }
    } catch (err: any) {
      console.error(`[DB] Error fetching MongoDB machine config for ${machineId}:`, err.message);
    }

    // 2. Fallback to Firebase Firestore machine doc
    try {
      const db = getFirestore();
      const machineDoc = await db.collection('machines').doc(actualMachineId).get();
      if (machineDoc.exists) {
        const data = machineDoc.data();
        if (data) {
          config.vendorUid = data.vendorUid || config.vendorUid;
          config.amount = data.amount !== undefined ? Number(data.amount) : config.amount;
          config.location = data.location || config.location;
          config.razorpayKeyId = data.razorpayKeyId || config.razorpayKeyId;
          config.razorpayKeySecret = data.razorpayKeySecret || config.razorpayKeySecret;

          if (!resolvedUserKeyId && config.vendorUid) {
            const firebaseLinkedUser = await User.findOne({
              $or: [{ _id: config.vendorUid }, { email: config.vendorUid }]
            });
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

    // 3. Prioritize credentials
    let finalKeyId = resolvedUserKeyId || config.razorpayKeyId;
    let finalKeySecret = resolvedUserKeySecret || config.razorpayKeySecret;

    if (!finalKeyId) {
      finalKeyId = process.env.RAZORPAY_KEY_ID || 'rzp_live_TGx9X5Tby0KVB8';
      finalKeySecret = process.env.RAZORPAY_KEY_SECRET || '9GizZR3GFrYMhKAwWESLSBnn';
    }

    config.razorpayKeyId = finalKeyId;
    config.razorpayKeySecret = finalKeySecret;

    const instance = new Razorpay({
      key_id: finalKeyId,
      key_secret: finalKeySecret
    });

    return { instance, config };
  }

  /**
   * Create Razorpay payment checkout link.
   */
  static async createPaymentLink(req: Request, res: Response) {
    try {
      const { machine_id } = req.body;
      if (!machine_id) return res.status(400).json({ error: 'machine_id parameter is required' });

      const { instance, config } = await PaymentController.getRazorpayInstance(machine_id);
      const resolvedMachineId = config.machineId;
      const amountInPaise = Math.round(config.amount * 100);

      const cachedLink = linkCache.get(resolvedMachineId);
      if (cachedLink && cachedLink.amount === amountInPaise) {
        return res.json({
          upi_intent: cachedLink.short_url,
          qr_id: cachedLink.id
        });
      }

      console.log(`[PAYMENT] Creating payment link for machine ${resolvedMachineId}`);
      const paymentLink = await instance.paymentLink.create({
        amount: amountInPaise,
        currency: 'INR',
        accept_partial: false,
        description: `Payment for FreshPod Kiosk`,
        customer: { name: 'FreshPod Customer' },
        notify: { sms: false, email: false },
        reminder_enable: false,
        notes: { machine_id: resolvedMachineId }
      });

      linkCache.set(resolvedMachineId, {
        id: paymentLink.id,
        short_url: paymentLink.short_url,
        amount: amountInPaise,
        machineId: resolvedMachineId
      });

      // Log pending payment link in database to enable credentials lookup on cache clear/restart
      try {
        await Payment.create({
          paymentId: paymentLink.id,
          qrId: paymentLink.id,
          machineId: resolvedMachineId,
          amount: Number(paymentLink.amount) / 100,
          method: 'Razorpay',
          status: 'pending',
          customerName: 'FreshPod Customer',
          customerEmail: 'N/A',
          customerPhone: 'N/A',
          timestamp: new Date()
        });
      } catch (dbErr: any) {
        console.error('[DB] Failed to create pending payment record:', dbErr.message);
      }

      res.json({
        upi_intent: paymentLink.short_url,
        qr_id: paymentLink.id
      });
    } catch (error: any) {
      console.error(`[API] Failed to create payment:`, error);
      res.status(502).json({ error: 'Failed to create payment link', details: error.message });
    }
  }

  /**
   * Verify online payment callback status.
   */
  static async verifyPaymentStatus(req: Request, res: Response) {
    const qr_id = req.query.qr_id as string;
    if (!qr_id) return res.status(400).json({ error: 'qr_id parameter is required' });

    let machineId = 'default';
    for (const [mId, cached] of linkCache.entries()) {
      if (cached.id === qr_id) {
        machineId = mId;
        break;
      }
    }

    if (machineId === 'default') {
      try {
        const pendingPayment = await Payment.findOne({ qrId: qr_id });
        if (pendingPayment) {
          machineId = pendingPayment.machineId;
        }
      } catch (err: any) {
        console.error('[DB] Error looking up pending payment:', err.message);
      }
    }

    try {
      const { instance } = await PaymentController.getRazorpayInstance(machineId);
      const paymentLink = await instance.paymentLink.fetch(qr_id);

      let status = 'pending';
      if (paymentLink.status === 'paid') {
        status = 'paid';
        if (machineId !== 'default') linkCache.delete(machineId);

        const actualMachineId = paymentLink.notes?.machine_id || machineId;

        let customerName = paymentLink.customer?.name || 'FreshPod Customer';
        let customerEmail = paymentLink.customer?.email || 'N/A';
        let customerPhone = paymentLink.customer?.contact || 'N/A';

        const paymentsArray = (paymentLink as any).payments;
        if (paymentsArray && paymentsArray.length > 0) {
          try {
            const firstPaymentId = paymentsArray[0].id;
            const actualPayment = await instance.payments.fetch(firstPaymentId);
            if (actualPayment) {
              customerEmail = actualPayment.email || customerEmail;
              customerPhone = actualPayment.contact || customerPhone;
              if (actualPayment.email) {
                customerName = actualPayment.email.split('@')[0];
              }
            }
          } catch (payFetchErr: any) {
            console.error('[Razorpay] Failed to fetch sub-payment details:', payFetchErr.message);
          }
        }

        await Payment.findOneAndUpdate(
          { qrId: qr_id },
          {
            $set: {
              paymentId: paymentLink.id,
              qrId: qr_id,
              machineId: String(actualMachineId),
              amount: Number(paymentLink.amount) / 100,
              method: 'Razorpay',
              status: 'paid',
              customerName,
              customerEmail,
              customerPhone,
              timestamp: new Date()
            }
          },
          { upsert: true, new: true }
        );

        if ((global as any).broadcastLiveEvent) {
          (global as any).broadcastLiveEvent('PAYMENT_UPDATE', {
            machineId: String(actualMachineId),
            qrId: qr_id,
            amount: Number(paymentLink.amount) / 100,
            method: 'Razorpay',
            status: 'paid',
            timestamp: new Date()
          });
        }
      } else if (paymentLink.status === 'expired' || paymentLink.status === 'cancelled') {
        status = 'failed';
      }

      res.json({ qr_id, status });
    } catch (error: any) {
      res.status(502).json({ error: 'Failed to verify payment status', details: error.message });
    }
  }

  /**
   * Manually sync and verify Razorpay links.
   */
  static async verifyPaymentManual(req: Request, res: Response) {
    try {
      const { qr_id } = req.body;
      if (!qr_id) return res.status(400).json({ error: 'qr_id parameter is required' });

      let machineId = 'default';
      for (const [mId, cached] of linkCache.entries()) {
        if (cached.id === qr_id) {
          machineId = mId;
          break;
        }
      }

      if (machineId === 'default') {
        try {
          const pendingPayment = await Payment.findOne({ qrId: qr_id });
          if (pendingPayment) {
            machineId = pendingPayment.machineId;
          }
        } catch (err: any) {
          console.error('[DB] Error looking up pending payment:', err.message);
        }
      }

      const { instance } = await PaymentController.getRazorpayInstance(machineId);
      const paymentLink = await instance.paymentLink.fetch(qr_id);
      const actualMachineId = String(paymentLink.notes?.machine_id || machineId);

      if (paymentLink.status === 'paid') {
        if (actualMachineId !== 'default') linkCache.delete(actualMachineId);

        let customerName = paymentLink.customer?.name || 'FreshPod Customer';
        let customerEmail = paymentLink.customer?.email || 'N/A';
        let customerPhone = paymentLink.customer?.contact || 'N/A';

        const paymentsArray = (paymentLink as any).payments;
        if (paymentsArray && paymentsArray.length > 0) {
          try {
            const firstPaymentId = paymentsArray[0].id;
            const actualPayment = await instance.payments.fetch(firstPaymentId);
            if (actualPayment) {
              customerEmail = actualPayment.email || customerEmail;
              customerPhone = actualPayment.contact || customerPhone;
              if (actualPayment.email) {
                customerName = actualPayment.email.split('@')[0];
              }
            }
          } catch (payFetchErr: any) {
            console.error('[Razorpay] Failed to fetch sub-payment details:', payFetchErr.message);
          }
        }

        await Payment.findOneAndUpdate(
          { qrId: qr_id },
          {
            $set: {
              paymentId: paymentLink.id,
              qrId: qr_id,
              machineId: actualMachineId,
              amount: Number(paymentLink.amount) / 100,
              method: 'Razorpay',
              status: 'paid',
              customerName,
              customerEmail,
              customerPhone,
              timestamp: new Date()
            }
          },
          { upsert: true, new: true }
        );

        if ((global as any).broadcastLiveEvent) {
          (global as any).broadcastLiveEvent('PAYMENT_UPDATE', {
            machineId: actualMachineId,
            qrId: qr_id,
            amount: Number(paymentLink.amount) / 100,
            method: 'Razorpay',
            status: 'paid',
            timestamp: new Date(),
            customerName,
            customerEmail,
            customerPhone
          });
        }

        return res.json({ success: true, status: 'paid', message: 'Payment link successfully verified and recorded.' });
      }

      res.json({ success: true, status: paymentLink.status, message: `Payment link status is: ${paymentLink.status}` });
    } catch (error: any) {
      res.status(502).json({ error: 'Failed manual verification', details: error.message });
    }
  }

  /**
   * Fetch payment histories with summaries.
   */
  static async getPaymentsHistory(req: any, res: Response) {
    try {
      const data = await PaymentService.getPaymentsHistory(req.user.id, req.user.role);
      res.json({
        success: true,
        summary: data.summary,
        payments: data.payments
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
}

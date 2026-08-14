import mongoose from 'mongoose';
import { Payment, Idempotency } from './payment.model';
import Machine from '../machine/machine.model';
import User from '../user/user.model';

export class PaymentService {

  /**
   * Fetch payment ledger and calculate total summaries for role views.
   */
  static async getPaymentsHistory(userId: string, role: string) {
    let query: any = {};
    let shouldFilterSensitiveData = true;

    if (role === 'admin') {
      shouldFilterSensitiveData = false;
    } else if (role === 'dealership') {
      const dealership = await User.findById(userId);
      const machineIds = (dealership?.assignedMachines || []).map(m => m.toString());
      
      const machines = await Machine.find({ 
        $or: [
          { dealership: userId },
          { _id: { $in: machineIds } }
        ]
      });
      const ids = machines.map((m: any) => m.machineId);
      query = { machineId: { $in: ids } };
      
    } else if (role === 'customer') {
      const machines = await Machine.find({ assignedTo: userId });
      const ids = machines.map((m: any) => m.machineId);
      query = { machineId: { $in: ids } };
      
    } else if (role === 'operator') {
      const machines = await Machine.find({ operatorId: userId });
      const ids = machines.map((m: any) => m.machineId);
      query = { machineId: { $in: ids } };
    }

    // Exclude soft deleted telemetry machines payments if necessary
    const payments = await Payment.find(query).sort({ timestamp: -1 });

    let totalAmount = 0;
    let mqttAmount = 0;
    let razorpayAmount = 0;

    const formattedPayments = payments.map((payment: any) => {
      const amt = payment.amount || 0;
      totalAmount += amt;

      if (payment.method === 'MQTT') {
        mqttAmount += amt;
      } else if (payment.method === 'Razorpay') {
        razorpayAmount += amt;
      }

      return {
        _id: payment._id.toString(),
        paymentId: payment.paymentId,
        qrId: payment.qrId || "",
        machineId: payment.machineId,
        amount: amt,
        method: payment.method,
        status: payment.status,
        timestamp: payment.timestamp,
        customerName: shouldFilterSensitiveData ? undefined : payment.customerName,
        customerEmail: shouldFilterSensitiveData ? undefined : payment.customerEmail,
        customerPhone: shouldFilterSensitiveData ? undefined : payment.customerPhone
      };
    });

    return {
      summary: {
        totalAmount,
        mqttAmount,
        razorpayAmount,
        count: formattedPayments.length
      },
      payments: formattedPayments
    };
  }

  /**
   * Helper to verify if an idempotency key is already cached.
   */
  static async checkIdempotency(key: string) {
    return await Idempotency.findOne({ key });
  }

  /**
   * Helper to cache an API response against an idempotency key.
   */
  static async saveIdempotency(key: string, status: number, body: any) {
    try {
      await Idempotency.create({ key, response: { status, body } });
    } catch (err: any) {
      console.warn('[Idempotency] Failed to cache idempotency key:', err.message);
    }
  }
}

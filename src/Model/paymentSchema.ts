import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IPayment extends Document {
  paymentId: string;
  qrId?: string | null;
  machineId: string;
  amount: number;
  method: 'Razorpay' | 'MQTT';
  status: 'pending' | 'paid' | 'failed';
  customerName?: string | null;
  customerEmail?: string | null;
  customerPhone?: string | null;
  timestamp: Date;
}

const paymentSchema = new Schema<IPayment>({
  paymentId: {
    type: String,
    required: true,
    unique: true,
    index: true
  },
  qrId: {
    type: String,
    default: null,
    index: true
  },
  machineId: {
    type: String,
    required: true,
    index: true
  },
  amount: {
    type: Number,
    required: true
  },
  method: {
    type: String,
    enum: ['Razorpay', 'MQTT'],
    required: true,
    index: true
  },
  status: {
    type: String,
    enum: ['pending', 'paid', 'failed'],
    default: 'pending',
    index: true
  },
  customerName: {
    type: String,
    default: 'N/A'
  },
  customerEmail: {
    type: String,
    default: 'N/A'
  },
  customerPhone: {
    type: String,
    default: 'N/A'
  },
  timestamp: {
    type: Date,
    default: Date.now,
    index: true
  }
}, {
  timestamps: true
});

const Payment: Model<IPayment> = mongoose.models.Payment || mongoose.model<IPayment>("Payment", paymentSchema);
export default Payment;

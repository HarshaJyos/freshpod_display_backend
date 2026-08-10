import mongoose, { Schema, Document, Model } from 'mongoose';

export interface ILog extends Document {
  machineId: string;
  date: string;
  tapCount: number;
  action: 'START' | 'TAP_DISPENSED' | 'CLEANING_STARTED' | 'CLEANING_COMPLETED' | 'STOP' | 'DISINFECTION_STARTED' | 'DISINFECTION_STOPPED' | 'DISINFECTION_COMPLETED' | 'CYCLE_COMPLETED';
  type: 'QR' | 'operator';
  status: 'sent' | 'processing' | 'completed' | 'failed';
  initiatedBy?: mongoose.Types.ObjectId | string | null;
  amount: number;
  sessionId?: string | null;
  sessionDuration: number;
  sessionTaps: number;
  qrId?: string | null;
  paymentId?: string | null;
  metadata: Record<string, any>;
  timestamp: Date;
}

const logSchema = new Schema<ILog>({
  machineId: {
    type: String,
    required: true,
    index: true
  },
  date: {
    type: String,
    required: true,
    default: () => new Date().toISOString().split('T')[0]
  },
  tapCount: {
    type: Number,
    default: 0
  },
  action: {
    type: String,
    enum: [
      'START', 
      'TAP_DISPENSED', 
      'CLEANING_STARTED', 
      'CLEANING_COMPLETED', 
      'STOP',
      'DISINFECTION_STARTED',
      'DISINFECTION_STOPPED',
      'DISINFECTION_COMPLETED',
      'CYCLE_COMPLETED'
    ],
    default: 'TAP_DISPENSED'
  },
  type: {
    type: String,
    enum: ['QR', 'operator'],
    default: 'operator'
  },
  status: {
    type: String,
    enum: ['sent', 'processing', 'completed', 'failed'],
    default: 'completed'
  },
  initiatedBy: {
    type: Schema.Types.ObjectId,
    ref: 'User',
    default: null
  },
  amount: {
    type: Number,
    default: 0
  },
  sessionId: {
    type: String,
    default: null
  },
  sessionDuration: {
    type: Number,
    default: 0
  },
  sessionTaps: {
    type: Number,
    default: 0
  },
  qrId: {
    type: String,
    default: null
  },
  paymentId: {
    type: String,
    default: null
  },
  metadata: {
    type: Schema.Types.Mixed,
    default: {}
  },
  timestamp: {
    type: Date,
    default: Date.now
  }
}, { 
  timestamps: true 
});

logSchema.index({ machineId: 1, date: -1 });
logSchema.index({ machineId: 1, timestamp: -1 });
logSchema.index({ action: 1, status: 1 });
logSchema.index({ type: 1 });
logSchema.index({ qrId: 1 });

const Log: Model<ILog> = mongoose.models.Log || mongoose.model<ILog>("Log", logSchema);
export default Log;

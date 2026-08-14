import mongoose, { Schema, Document, Model } from 'mongoose';

/* ======================================================
   1. MACHINE MODEL SCHEMA
====================================================== */
export interface IMachine extends Document {
  machineId: string;
  qrId?: string;
  location: string;
  costPerTap: number;
  totalTaps: number;
  status: 'active' | 'inactive' | 'maintenance' | 'error';
  lastError?: string;
  dealership?: mongoose.Types.ObjectId | string | null;
  operatorId?: mongoose.Types.ObjectId | string | null;
  assignedTo?: mongoose.Types.ObjectId | string | null;
  razorpayKeyId?: string;
  razorpayKeySecret?: string;
  isDeleted?: boolean;
  deletedAt?: Date | null;
}

const machineSchema = new Schema<IMachine>({
  machineId: {
    type: String,
    required: true,
    unique: true
  },
  qrId: {
    type: String,
    unique: true,
    sparse: true 
  },
  location: {
    type: String,
    required: true
  },
  costPerTap: {
    type: Number,
    required: true,
    min: 0
  },
  totalTaps: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ['active', 'inactive', 'maintenance', 'error'],
    default: 'active'
  },
  lastError: {
    type: String,
    default: ""
  },
  dealership: {
    type: Schema.Types.ObjectId,
    ref: "User",
    default: null
  },
  operatorId: {
    type: Schema.Types.ObjectId,
    ref: "User",
    default: null
  },
  assignedTo: {
    type: Schema.Types.ObjectId,
    ref: "User",
    default: null
  },
  razorpayKeyId: {
    type: String,
    default: ""
  },
  razorpayKeySecret: {
    type: String,
    default: ""
  },
  isDeleted: {
    type: Boolean,
    default: false,
    index: true
  },
  deletedAt: {
    type: Date,
    default: null
  }
}, { timestamps: true });

export const Machine: Model<IMachine> = mongoose.models.Machine || mongoose.model<IMachine>("Machine", machineSchema);

/* ======================================================
   2. LOG MODEL SCHEMA (TELEMETRY RUNS)
====================================================== */
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
    ref: "User",
    default: null
  },
  amount: {
    type: Number,
    required: true,
    min: 0
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
    default: Date.now,
    index: true
  }
}, { timestamps: true });

logSchema.index({ machineId: 1, date: 1 });

export const Log: Model<ILog> = mongoose.models.Log || mongoose.model<ILog>("Log", logSchema);

/* ======================================================
   3. CUSTOMER SETTINGS MODEL SCHEMA
====================================================== */
export interface ICustomerMachineSettings extends Document {
  customerId: mongoose.Types.ObjectId | string;
  machineId: mongoose.Types.ObjectId | string;
  machineCode: string;
  costPerTap: number;
  rentPerMonth: number;
  maintenanceCostPerMonth: number;
  createdAt: Date;
  updatedAt: Date;
}

const customerMachineSettingsSchema = new Schema<ICustomerMachineSettings>({
  customerId: {
    type: Schema.Types.ObjectId,
    ref: "User",
    required: true,
    index: true
  },
  machineId: {
    type: Schema.Types.ObjectId,
    ref: "Machine",
    required: true,
    index: true
  },
  machineCode: {
    type: String,
    required: true
  },
  costPerTap: {
    type: Number,
    default: 0.50,
    min: 0
  },
  rentPerMonth: {
    type: Number,
    default: 0,
    min: 0
  },
  maintenanceCostPerMonth: {
    type: Number,
    default: 0,
    min: 0
  },
  createdAt: {
    type: Date,
    default: Date.now
  },
  updatedAt: {
    type: Date,
    default: Date.now
  }
});

customerMachineSettingsSchema.pre('save', function(next: any) {
  this.updatedAt = new Date();
  next();
});

export const CustomerMachineSettings: Model<ICustomerMachineSettings> = mongoose.models.CustomerMachineSettings || mongoose.model<ICustomerMachineSettings>("CustomerMachineSettings", customerMachineSettingsSchema);

/* ======================================================
   4. SANITIZATION REFILL SCHEMAS
====================================================== */
export interface ISanitizationRefill extends Document {
  machineId: string;
  start: Date;
  tapCountAtRefill: number;
  containerSize: number;
  usagePerTap: number;
  refilledBy?: mongoose.Types.ObjectId | string;
  notes: string;
}

const SanitizationRefillSchema = new Schema<ISanitizationRefill>({
  machineId: {
    type: String,
    required: true,
    index: true
  },
  start: {
    type: Date,
    required: true,
    default: Date.now
  },
  tapCountAtRefill: {
    type: Number,
    required: true,
    default: 0
  },
  containerSize: {
    type: Number,
    default: 5
  },
  usagePerTap: {
    type: Number,
    default: 0.012
  },
  refilledBy: {
    type: Schema.Types.ObjectId,
    ref: "User"
  },
  notes: {
    type: String,
    default: ""
  }
}, { timestamps: true });

export const SanitizationRefill: Model<ISanitizationRefill> = mongoose.models.SanitizationRefill || mongoose.model<ISanitizationRefill>('SanitizationRefill', SanitizationRefillSchema);

export default Machine;

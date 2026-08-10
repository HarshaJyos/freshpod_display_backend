import mongoose, { Schema, Document, Model } from 'mongoose';

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

customerMachineSettingsSchema.index({ customerId: 1, machineId: 1 }, { unique: true });

const CustomerMachineSettings: Model<ICustomerMachineSettings> = mongoose.models.CustomerMachineSettings || mongoose.model<ICustomerMachineSettings>("CustomerMachineSettings", customerMachineSettingsSchema);
export default CustomerMachineSettings;

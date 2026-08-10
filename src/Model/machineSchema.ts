import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IMachine extends Document {
  machineId: string;
  qrId?: string;
  location: string;
  state?: string;
  country: string;
  machineCost: number;
  costPerTap: number;
  totalTaps: number;
  status: 'active' | 'inactive' | 'maintenance';
  dealership?: mongoose.Types.ObjectId | string | null;
  operatorId?: mongoose.Types.ObjectId | string | null;
  assignedTo?: mongoose.Types.ObjectId | string | null;
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
  state: String,
  country: {
    type: String,
    default: "India"
  },
  machineCost: {
    type: Number,
    required: true,
    default: 100
  },
  costPerTap: {
    type: Number,
    required: true
  },
  totalTaps: {
    type: Number,
    default: 0
  },
  status: {
    type: String,
    enum: ["active", "inactive", "maintenance"],
    default: "active"
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
  }
}, { timestamps: true });

const Machine: Model<IMachine> = mongoose.models.Machine || mongoose.model<IMachine>("Machine", machineSchema);
export default Machine;

import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IFirmware extends Document {
  machineId: string;
  machineName: string;
  version: string;
  file: {
    public_id: string;
    url: string;
    size: number;
  };
  qrvalue: number; // Stored as a mapped number (0 to 6) representing amount tiers
  createdAt: Date;
  updatedAt: Date;
}

const firmwareSchema = new Schema<IFirmware>({
  machineId: {
    type: String,
    required: true,
    index: true
  },
  machineName: {
    type: String,
    required: true
  },
  version: {
    type: String,
    required: true
  },
  file: {
    public_id: { type: String, required: true },
    url: { type: String, required: true },
    size: { type: Number, required: true }
  },
  qrvalue: {
    type: Number,
    enum: [0, 1, 2, 3, 4, 5, 6],
    required: true,
    default: 0
  }
}, { timestamps: true });

export const Firmware: Model<IFirmware> = mongoose.models.Firmware || mongoose.model<IFirmware>('Firmware', firmwareSchema);

import mongoose, { Schema, Document, Model } from 'mongoose';

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
}, {
  timestamps: true
});

const SanitizationRefill: Model<ISanitizationRefill> = mongoose.models.SanitizationRefill || mongoose.model<ISanitizationRefill>('SanitizationRefill', SanitizationRefillSchema);
export default SanitizationRefill;

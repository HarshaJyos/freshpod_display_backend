import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IReport extends Document {
  reportId: string;
  customer: {
    id: string;
    email: string;
  };
  subject: string;
  description: string;
  status: 'pending' | 'solved';
  resolvedAt?: Date | null;
  resolutionNotes?: string | null;
  isDeleted?: boolean;
  deletedAt?: Date | null;
  markAsSolved(notes?: string): Promise<IReport>;
  getStatusDisplay(): string;
}

const reportSchema = new Schema<IReport>({
  reportId: {
    type: String,
    unique: true,
    required: true,
    index: true
  },
  customer: {
    id: { 
      type: String, 
      required: true,
      index: true
    },
    email: { 
      type: String, 
      required: true 
    }
  },
  subject: {
    type: String,
    required: true
  },
  description: {
    type: String,
    required: true
  },
  status: {
    type: String,
    enum: ['pending', 'solved'],
    default: 'pending',
    index: true
  },
  resolvedAt: {
    type: Date,
    default: null
  },
  resolutionNotes: {
    type: String,
    default: null
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
}, {
  timestamps: true
});

reportSchema.index({ 'customer.id': 1, status: 1 });
reportSchema.index({ createdAt: -1 });

reportSchema.methods.markAsSolved = function(notes?: string): Promise<IReport> {
  this.status = 'solved';
  this.resolvedAt = new Date();
  if (notes) {
    this.resolutionNotes = notes;
  }
  return this.save();
};

reportSchema.methods.getStatusDisplay = function(): string {
  return this.status.toUpperCase();
};

const Report: Model<IReport> = mongoose.models.Report || mongoose.model<IReport>("Report", reportSchema);
export default Report;

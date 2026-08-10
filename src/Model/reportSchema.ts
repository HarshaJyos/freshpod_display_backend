import mongoose, { Schema, Document, Model } from 'mongoose';

export interface IReport extends Document {
  reportId: string;
  customer: {
    id: string;
    email: string;
    name: string;
    phone: string;
  };
  subject: string;
  description: string;
  status: 'pending' | 'solved';
  resolvedAt?: Date | null;
  resolutionNotes?: string | null;
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
    },
    name: { 
      type: String, 
      required: true 
    },
    phone: {
      type: String,
      default: 'N/A'
    }
  },
  subject: { 
    type: String, 
    required: true,
    trim: true,
    maxlength: 200
  },
  description: { 
    type: String, 
    required: true,
    trim: true,
    maxlength: 1000
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
  }
}, {
  timestamps: true
});

reportSchema.index({ 'customer.id': 1, status: 1 });
reportSchema.index({ createdAt: -1 });

reportSchema.methods.markAsSolved = function(notes?: string): Promise<IReport> {
  this.status = 'solved';
  this.resolvedAt = new Date();
  this.resolutionNotes = notes || 'Issue resolved';
  return this.save();
};

reportSchema.methods.getStatusDisplay = function(): string {
  return this.status === 'solved' ? '✅ Solved' : '⏳ Pending';
};

const Report: Model<IReport> = mongoose.models.Report || mongoose.model<IReport>('Report', reportSchema);
export default Report;

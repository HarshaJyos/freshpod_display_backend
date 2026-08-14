import mongoose, { Schema, Document, Model } from 'mongoose';
import bcrypt from 'bcrypt';
import jwt from 'jsonwebtoken';

export interface IUser extends Document {
  name: string;
  email: string;
  password?: string;
  role: 'admin' | 'dealership' | 'customer' | 'operator';
  phoneNumber: string;
  location?: string;
  state: string;
  country: string;
  parent?: mongoose.Types.ObjectId | string | null;
  assignedMachines: (mongoose.Types.ObjectId | string)[];
  isFirstLogin: boolean;
  refreshToken?: string | null;
  razorpayKeyId?: string;
  razorpayKeySecret?: string;
  isDeleted?: boolean;
  deletedAt?: Date | null;
  comparePassword(candidatePassword: string): Promise<boolean>;
  generateAccessToken(): string;
  generateRefreshToken(): string;
}

const userSchema = new Schema<IUser>({
  name: { type: String, required: true },
  email: {
    type: String,
    required: true,
    unique: true,
    lowercase: true,
    trim: true
  },
  password: {
    type: String,
    required: true
  },
  role: {
    type: String,
    enum: ['admin', 'dealership', 'customer', 'operator'],
    required: true
  },
  phoneNumber: {
    type: String,
    required: true,
    unique: true
  },
  location: {
    type: String,
    default: ""
  },
  state: {
    type: String,
    required: true
  },
  country: {
    type: String,
    required: true
  },
  parent: {
    type: Schema.Types.ObjectId,
    ref: "User",
    default: null
  },
  assignedMachines: [{
    type: Schema.Types.ObjectId,
    ref: "Machine"
  }],
  isFirstLogin: {
    type: Boolean,
    default: true
  },
  refreshToken: {
    type: String,
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

// Set password from phoneNumber only for new documents
userSchema.pre('validate', function() {
  if (this.isNew && !this.password && this.phoneNumber) {
    this.password = this.phoneNumber;
  }
});

// Hash password only if modified
userSchema.pre('save', async function(this: IUser) {
  if (!this.isModified('password')) return;
  // Check if password is already hashed
  if (this.password && this.password.startsWith('$2b$')) return;

  const salt = await bcrypt.genSalt(10);
  this.password = await bcrypt.hash(this.password!, salt);
});

// Method to compare passwords
userSchema.methods.comparePassword = async function(candidatePassword: string): Promise<boolean> {
  return await bcrypt.compare(candidatePassword, this.password || '');
};

// Method to generate Access Token
userSchema.methods.generateAccessToken = function(): string {
  const secret = process.env.JWT_SECRET || 'fallback_access_secret';
  return jwt.sign(
    { id: this._id, email: this.email, role: this.role },
    secret,
    { expiresIn: '15m' }
  );
};

// Method to generate Refresh Token
userSchema.methods.generateRefreshToken = function(): string {
  const secret = process.env.JWT_REFRESH_SECRET || 'fallback_refresh_secret';
  return jwt.sign(
    { id: this._id },
    secret,
    { expiresIn: '7d' }
  );
};

const User: Model<IUser> = mongoose.models.User || mongoose.model<IUser>("User", userSchema);
export default User;

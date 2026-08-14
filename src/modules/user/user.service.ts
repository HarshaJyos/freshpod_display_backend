import mongoose from 'mongoose';
import User, { IUser } from './user.model';
import Machine from '../machine/machine.model';
import jwt from 'jsonwebtoken';

/**
 * Service to manage authentication, registration, profile updates,
 * and session-transaction wrapped user operations.
 */
export class UserService {
  
  /**
   * Authenticate email and password, generate tokens, and save session refresh token.
   * @param email user email
   * @param password user password
   */
  static async authenticateUser(email: string, password: string) {
    const formattedEmail = email.toLowerCase().trim();
    const user = await User.findOne({ email: formattedEmail, isDeleted: { $ne: true } });
    if (!user) throw new Error('Invalid email or password');

    const isMatch = await user.comparePassword(password);
    if (!isMatch) throw new Error('Invalid email or password');

    const accessToken = user.generateAccessToken();
    const refreshToken = user.generateRefreshToken();

    user.refreshToken = refreshToken;
    await user.save();

    return { user, accessToken, refreshToken };
  }

  /**
   * Verify refresh token and generate a fresh short-lived access token.
   * @param token refresh token string
   */
  static async refreshAccessToken(token: string) {
    const secret = process.env.REFRESH_TOKEN_SECRET || 'fallback_refresh_secret';
    const decoded: any = jwt.verify(token, secret);
    
    const user = await User.findOne({ _id: decoded.id, refreshToken: token, isDeleted: { $ne: true } });
    if (!user) throw new Error('Invalid refresh token');

    const accessToken = user.generateAccessToken();
    return { accessToken };
  }

  /**
   * Create a new user account and bind machine inventory using ACID transaction sessions.
   */
  static async createUser(userData: Partial<IUser>, assignedMachineIds: string[], parentId: string) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const { email, phoneNumber, role } = userData;

      // 1. Validate unique constraints
      const existingPhone = await User.findOne({ phoneNumber }).session(session);
      if (existingPhone) throw new Error('DUPLICATE_PHONE_NUMBER');

      const existingEmail = await User.findOne({ email: email?.toLowerCase().trim() }).session(session);
      if (existingEmail) throw new Error('DUPLICATE_EMAIL');

      // 2. Validate machine stock assignments
      if (assignedMachineIds.length > 0) {
        const machines = await Machine.find({ _id: { $in: assignedMachineIds }, isDeleted: { $ne: true } }).session(session);
        if (machines.length !== assignedMachineIds.length) {
          throw new Error('INVALID_MACHINES');
        }
        const alreadyAssigned = machines.filter(m => m.assignedTo !== null || m.dealership !== null || m.operatorId !== null);
        if (alreadyAssigned.length > 0) {
          throw new Error('MACHINES_ALREADY_ASSIGNED');
        }
      }

      // 3. Create user document
      const [user] = await User.create([{
        ...userData,
        parent: parentId,
        assignedMachines: []
      }], { session });

      // 4. Link hardware structures
      if (assignedMachineIds.length > 0) {
        const updateData: any = {};
        if (role === 'dealership') updateData.dealership = user._id;
        else if (role === 'operator') updateData.operatorId = user._id;
        else if (role === 'customer') updateData.assignedTo = user._id;

        await Machine.updateMany(
          { _id: { $in: assignedMachineIds } },
          { $set: updateData },
          { session }
        );

        user.assignedMachines = assignedMachineIds;
        await user.save({ session });
      }

      await session.commitTransaction();
      session.endSession();

      return await User.findById(user._id)
        .select("-password")
        .populate('assignedMachines', 'machineId location status totalTaps');

    } catch (err: any) {
      await session.abortTransaction();
      session.endSession();
      throw err;
    }
  }

  /**
   * Soft-delete user and release all kiosk linkages atomically.
   */
  static async softDeleteUser(userId: string) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const user = await User.findById(userId).session(session);
      if (!user) throw new Error('USER_NOT_FOUND');

      let affectedMachines = [];
      let updateResult: any = {};

      if (user.role === 'dealership') {
        affectedMachines = await Machine.find({ dealership: user._id }).session(session);
        updateResult = await Machine.updateMany(
          { dealership: user._id },
          { $set: { dealership: null, assignedTo: null, operatorId: null } },
          { session }
        );
      } else if (user.role === 'customer') {
        affectedMachines = await Machine.find({ assignedTo: user._id }).session(session);
        updateResult = await Machine.updateMany(
          { assignedTo: user._id },
          { $set: { assignedTo: null, operatorId: null } },
          { session }
        );
      } else if (user.role === 'operator') {
        affectedMachines = await Machine.find({ operatorId: user._id }).session(session);
        updateResult = await Machine.updateMany(
          { operatorId: user._id },
          { $set: { operatorId: null } },
          { session }
        );
      } else {
        affectedMachines = await Machine.find({
          $or: [{ dealership: user._id }, { assignedTo: user._id }, { operatorId: user._id }]
        }).session(session);
        updateResult = await Machine.updateMany(
          { $or: [{ dealership: user._id }, { assignedTo: user._id }, { operatorId: user._id }] },
          { $set: { dealership: null, assignedTo: null, operatorId: null } },
          { session }
        );
      }

      user.assignedMachines = [];
      user.isDeleted = true;
      user.deletedAt = new Date();
      await user.save({ session });

      await session.commitTransaction();
      session.endSession();

      return { user, affectedMachines, modifiedCount: updateResult.modifiedCount || 0 };
    } catch (err: any) {
      await session.abortTransaction();
      session.endSession();
      throw err;
    }
  }
}

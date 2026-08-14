import { Request, Response } from 'express';
import { UserService } from './user.service';
import User from './user.model';
import Machine from '../machine/machine.model';

/**
 * Controller to handle HTTP requests for user profiles, directory,
 * logins, token refreshes, password changes, and account deletions.
 */
export class UserController {

  /**
   * User login session initialization.
   */
  static async login(req: Request, res: Response) {
    try {
      const { email, password } = req.body;
      if (typeof email !== 'string' || typeof password !== 'string') {
        return res.status(400).json({ message: "Invalid email or password input format" });
      }
      const { user, accessToken, refreshToken } = await UserService.authenticateUser(email, password);

      res.json({
        accessToken,
        refreshToken,
        role: user.role,
        userId: user._id,
        isFirstLogin: user.isFirstLogin
      });
    } catch (err: any) {
      console.error("Login error:", err.message);
      res.status(401).json({ message: err.message });
    }
  }

  /**
   * Refresh expired access token.
   */
  static async refreshToken(req: Request, res: Response) {
    try {
      const { refreshToken } = req.body;
      if (!refreshToken) return res.status(401).json({ message: "No refresh token" });

      const { accessToken } = await UserService.refreshAccessToken(refreshToken);
      res.json({ accessToken });
    } catch (err: any) {
      res.status(403).json({ message: "Expired or invalid refresh token" });
    }
  }

  /**
   * Update profile password.
   */
  static async changePassword(req: any, res: Response) {
    try {
      const { oldPassword, newPassword } = req.body;
      if (typeof oldPassword !== 'string' || typeof newPassword !== 'string') {
        return res.status(400).json({ message: "Invalid password input format" });
      }
      if (newPassword.length < 6) {
        return res.status(400).json({ message: "Password must be at least 6 characters" });
      }

      const user = await User.findById(req.user.id).select("+password");
      if (!user) return res.status(404).json({ message: "User not found" });

      const isMatch = await user.comparePassword(oldPassword);
      if (!isMatch) return res.status(400).json({ message: "Old password incorrect" });

      user.password = newPassword;
      user.isFirstLogin = false;
      await user.save();

      res.json({ message: "Password updated successfully" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /**
   * User logout and token cleanup.
   */
  static async logout(req: any, res: Response) {
    try {
      const user = await User.findById(req.user.id);
      if (user) {
        user.refreshToken = null;
        await user.save();
      }
      res.json({ message: "Logged out successfully" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /**
   * Fetch current authenticated profile.
   */
  static async getProfile(req: any, res: Response) {
    try {
      const user = await User.findById(req.user.id).select("-password -refreshToken");
      if (!user) return res.status(404).json({ message: "User not found" });
      res.json(user);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /**
   * Update profile parameters.
   */
  static async updateProfile(req: any, res: Response) {
    try {
      const { name, phoneNumber, location, razorpayKeyId, razorpayKeySecret } = req.body;
      const user = await User.findById(req.user.id);
      if (!user) return res.status(404).json({ message: "User not found" });

      if (phoneNumber && !/^[0-9]{10}$/.test(phoneNumber)) {
        return res.status(400).json({ message: "Invalid phone number" });
      }

      if (name !== undefined) user.name = name;
      if (phoneNumber !== undefined) user.phoneNumber = phoneNumber;
      if (location !== undefined) user.location = location;
      if (razorpayKeyId !== undefined) user.razorpayKeyId = razorpayKeyId;
      if (razorpayKeySecret !== undefined) user.razorpayKeySecret = razorpayKeySecret;

      await user.save();

      res.json({
        message: "Profile updated successfully",
        user: {
          _id: user._id,
          name: user.name,
          email: user.email,
          phoneNumber: user.phoneNumber,
          location: user.location,
          razorpayKeyId: user.razorpayKeyId,
          razorpayKeySecret: user.razorpayKeySecret
        }
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /**
   * Retrieve active directory users (filters out soft deletes).
   */
  static async getUsers(req: any, res: Response) {
    try {
      let query: any = { isDeleted: { $ne: true } };
      if (req.user.role === "dealership") {
        query = { parent: req.user.id, role: "customer", isDeleted: { $ne: true } };
      }

      const users = await User.find(query)
        .select("-password -refreshToken")
        .populate("assignedMachines", "machineId location status");

      res.json(users);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /**
   * Create a new user with transactional ACID safety.
   */
  static async createUser(req: any, res: Response) {
    try {
      const { name, email, phoneNumber, location, state, country = "India", role, assignedMachineIds = [], razorpayKeyId, razorpayKeySecret } = req.body;
      const validRoles = ["admin", "dealership", "operator", "customer"];
      if (!validRoles.includes(role)) {
        return res.status(400).json({ error: "Invalid role specified" });
      }

      const user = await UserService.createUser({
        name,
        email,
        phoneNumber,
        location,
        state,
        country,
        role,
        razorpayKeyId,
        razorpayKeySecret
      }, assignedMachineIds, req.user.id);

      res.status(201).json({
        success: true,
        message: "User created successfully",
        user
      });
    } catch (err: any) {
      if (err.message === 'DUPLICATE_PHONE_NUMBER') {
        return res.status(400).json({ 
          error: "DUPLICATE_PHONE_NUMBER",
          message: "This mobile number is already registered with another account"
        });
      }
      if (err.message === 'DUPLICATE_EMAIL') {
        return res.status(400).json({ 
          error: "DUPLICATE_EMAIL",
          message: "This email is already registered with another account"
        });
      }
      if (err.message === 'INVALID_MACHINES') {
        return res.status(400).json({ 
          error: "INVALID_MACHINES",
          message: "Some machines do not exist in the system" 
        });
      }
      if (err.message === 'MACHINES_ALREADY_ASSIGNED') {
        return res.status(400).json({ 
          error: "MACHINES_ALREADY_ASSIGNED",
          message: "Some machines are already assigned to other users"
        });
      }

      console.error("Error creating user:", err);
      res.status(500).json({ error: err.message });
    }
  }

  /**
   * Update directory user details.
   */
  static async updateUser(req: any, res: Response) {
    try {
      const { id } = req.params;
      const { name, email, phoneNumber, location, state, assignedMachineIds = [], razorpayKeyId, razorpayKeySecret } = req.body;

      const user = await User.findById(id);
      if (!user) return res.status(404).json({ error: "User not found" });

      const oldAssigned = user.assignedMachines.map(m => m.toString());
      const toAdd = assignedMachineIds.filter((m: string) => !oldAssigned.includes(m));
      const toRemove = oldAssigned.filter(m => !assignedMachineIds.includes(m));

      // Release unassigned machines
      if (toRemove.length) {
        const updateData: any = {};
        if (user.role === 'dealership') updateData.dealership = null;
        else if (user.role === 'operator') updateData.operatorId = null;
        else if (user.role === 'customer') updateData.assignedTo = null;

        await Machine.updateMany({ _id: { $in: toRemove } }, { $set: updateData });
      }

      // Allocate newly assigned machines
      if (toAdd.length) {
        const validMachines = await Machine.find({ _id: { $in: toAdd }, isDeleted: { $ne: true } });
        if (validMachines.length !== toAdd.length) {
          return res.status(400).json({ error: "Some machines do not exist" });
        }

        const updateData: any = {};
        if (user.role === 'dealership') updateData.dealership = user._id;
        else if (user.role === 'operator') updateData.operatorId = user._id;
        else if (user.role === 'customer') updateData.assignedTo = user._id;

        await Machine.updateMany({ _id: { $in: toAdd } }, { $set: updateData });
      }

      if (name !== undefined) user.name = name;
      if (email !== undefined) user.email = email;
      if (phoneNumber !== undefined) user.phoneNumber = phoneNumber;
      if (location !== undefined) user.location = location;
      if (state !== undefined) user.state = state;
      if (razorpayKeyId !== undefined) user.razorpayKeyId = razorpayKeyId;
      if (razorpayKeySecret !== undefined) user.razorpayKeySecret = razorpayKeySecret;
      
      user.assignedMachines = assignedMachineIds;
      await user.save();

      const populated = await User.findById(user._id)
        .select("-password")
        .populate('assignedMachines', 'machineId location status totalTaps');

      res.json({
        success: true,
        message: "User updated successfully",
        user: populated
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /**
   * Soft delete directory user and release inventory links.
   */
  static async deleteUser(req: any, res: Response) {
    try {
      const { id } = req.params;
      const { user, affectedMachines, modifiedCount } = await UserService.softDeleteUser(id);

      res.json({
        success: true,
        message: "User soft-deleted successfully.",
        data: {
          deletedUser: {
            id: user._id,
            name: user.name,
            email: user.email,
            role: user.role
          },
          machinesAffected: affectedMachines.map((m: any) => ({
            id: m._id,
            machineId: m.machineId,
            location: m.location
          })),
          totalMachinesUpdated: modifiedCount
        }
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /**
   * Create a Customer account linked to a Dealership.
   */
  static async createCustomer(req: any, res: Response) {
    try {
      const { name, email, phoneNumber, location, assignedMachineIds = [] } = req.body;
      if (!name || !phoneNumber || !email || !location) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      const exists = await User.findOne({ email });
      if (exists) return res.status(400).json({ message: "User already exists" });

      const parentDealer = await User.findById(req.user.id);
      if (!parentDealer) return res.status(404).json({ message: "Dealership not found" });

      // Validate machines assigned to dealer
      let validatedMachines: any[] = [];
      if (assignedMachineIds.length > 0) {
        validatedMachines = await Machine.find({
          _id: { $in: assignedMachineIds },
          dealership: parentDealer._id,
          assignedTo: null
        });

        if (validatedMachines.length !== assignedMachineIds.length) {
          return res.status(400).json({ message: "Some machines are invalid or already sold" });
        }
      }

      const customer = await User.create({
        name,
        email,
        phoneNumber,
        location,
        state: parentDealer.state,
        country: parentDealer.country,
        role: "customer",
        parent: parentDealer._id,
        assignedMachines: validatedMachines.map(m => m._id)
      });

      if (validatedMachines.length > 0) {
        await Machine.updateMany(
          { _id: { $in: validatedMachines.map(m => m._id) } },
          { $set: { assignedTo: customer._id } }
        );
      }

      res.status(201).json({
        message: "Customer created successfully",
        user: { id: customer._id, name: customer.name, email: customer.email }
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /**
   * Get all Customer accounts linked to this Dealership.
   */
  static async getCustomers(req: any, res: Response) {
    try {
      const customers = await User.find({
        parent: req.user.id,
        role: "customer",
        isDeleted: { $ne: true }
      }).select("-password -refreshToken").populate("assignedMachines", "machineId location status");

      res.json(customers);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /**
   * Create an Operator account linked to a Customer.
   */
  static async createOperator(req: any, res: Response) {
    try {
      const { name, email, phoneNumber, location, assignedMachineIds = [] } = req.body;
      if (!name || !phoneNumber || !email) {
        return res.status(400).json({ message: "Missing required fields" });
      }

      const exists = await User.findOne({ email });
      if (exists) return res.status(400).json({ message: "User already exists" });

      const parentCustomer = await User.findById(req.user.id);
      if (!parentCustomer) return res.status(404).json({ message: "Customer profile not found" });

      // Validate assigned machines
      let validatedMachines: any[] = [];
      if (assignedMachineIds.length > 0) {
        validatedMachines = await Machine.find({
          _id: { $in: assignedMachineIds },
          assignedTo: parentCustomer._id
        });

        if (validatedMachines.length !== assignedMachineIds.length) {
          return res.status(400).json({ message: "Some machines do not belong to your account" });
        }
      }

      const operator = await User.create({
        name,
        email,
        phoneNumber,
        location: location || parentCustomer.location,
        state: parentCustomer.state,
        country: parentCustomer.country,
        role: "operator",
        parent: parentCustomer._id,
        assignedMachines: validatedMachines.map(m => m._id)
      });

      if (validatedMachines.length > 0) {
        await Machine.updateMany(
          { _id: { $in: validatedMachines.map(m => m._id) } },
          { $set: { operatorId: operator._id } }
        );
      }

      res.status(201).json({
        message: "Operator created successfully",
        user: { id: operator._id, name: operator.name, email: operator.email }
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /**
   * List all Operator accounts linked to this Customer.
   */
  static async getOperators(req: any, res: Response) {
    try {
      const operators = await User.find({
        parent: req.user.id,
        role: "operator",
        isDeleted: { $ne: true }
      }).select("-password -refreshToken").populate("assignedMachines", "machineId location status");

      res.json(operators);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /**
   * Delete an Operator account.
   */
  static async deleteOperator(req: any, res: Response) {
    try {
      const { operatorId } = req.params;
      const operator = await User.findOne({ _id: operatorId, parent: req.user.id, role: 'operator' });
      if (!operator) return res.status(404).json({ message: "Operator not found" });

      // Unassign machines from operator
      await Machine.updateMany(
        { operatorId: operator._id },
        { $set: { operatorId: null } }
      );

      operator.isDeleted = true;
      operator.deletedAt = new Date();
      operator.assignedMachines = [];
      await operator.save();

      res.json({ message: "Operator soft-deleted successfully" });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }
}

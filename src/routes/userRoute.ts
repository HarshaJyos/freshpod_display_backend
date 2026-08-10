// @ts-nocheck
import { Router, Response } from 'express';
import { auth } from '../middleware/auth';
import User from '../Model/userSchema';
import Machine from '../Model/machineSchema';
import Log from '../Model/logSchema';
import jwt from 'jsonwebtoken';

const router = Router();

router.post("/login", async (req: any, res: Response) => {
  try {
    const { email, password } = req.body;

    const user = await User.findOne({ email }).select("+password +refreshToken");

    if (!user) {
      return res.status(401).json({ message: "Invalid credentials" });
    }
      
    const isMatch = await user.comparePassword(password);
    
    if (!isMatch) {
      return res.status(401).json({ message: "Invalid credentials" });
    }

    const accessToken = user.generateAccessToken();
    const refreshToken = user.generateRefreshToken();

    user.refreshToken = refreshToken;
    await user.save();

    res.json({
      accessToken,
      refreshToken,
      role: user.role,
      userId: user._id,
      isFirstLogin: user.isFirstLogin
    });

  } catch (err: any) {
    console.error("Login error:", err);
    res.status(500).json({ error: err.message });
  }
});

router.post("/refresh-token", async (req: any, res: Response) => {
  try {
    const { refreshToken } = req.body;

    if (!refreshToken) {
      return res.status(401).json({ message: "No refresh token" });
    }

    const secret = process.env.JWT_REFRESH_SECRET;
    if (!secret) throw new Error("JWT_REFRESH_SECRET key missing");
    const decoded = jwt.verify(refreshToken, secret) as { id: string };
    const user = await User.findById(decoded.id).select("+refreshToken");

    if (!user || user.refreshToken !== refreshToken) {
      return res.status(403).json({ message: "Invalid refresh token" });
    }

    const newAccessToken = user.generateAccessToken();
    const newRefreshToken = user.generateRefreshToken();

    user.refreshToken = newRefreshToken;
    await user.save();

    res.json({
      accessToken: newAccessToken,
      refreshToken: newRefreshToken
    });

  } catch (err) {
    return res.status(403).json({ message: "Expired refresh token" });
  }
});

router.post("/change-password", auth, async (req: any, res: Response) => {
  try {
    const { oldPassword, newPassword } = req.body;

    if (!newPassword || newPassword.length < 6) {
      return res.status(400).json({
        message: "Password must be at least 6 characters"
      });
    }

    const user = await User.findById(req.user!.id).select("+password");

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

    const isMatch = await user.comparePassword(oldPassword);
    if (!isMatch) {
      return res.status(400).json({ message: "Old password incorrect" });
    }

    user.password = newPassword;
    user.isFirstLogin = false;
    await user.save();

    res.json({ message: "Password updated successfully" });

  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.post("/logout", auth, async (req: any, res: Response) => {
  try {
    const user = await User.findById(req.user!.id);
    if (user) {
      user.refreshToken = null;
      await user.save();
    }
    res.json({ message: "Logged out successfully" });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.get("/profile", auth, async (req: any, res: Response) => {
  try {
    const user = await User.findById(req.user!.id).select("-password -refreshToken");
    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }
    res.json(user);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

router.put("/update-profile", auth, async (req: any, res: Response) => {
  try {
    const { name, phoneNumber, location, razorpayKeyId, razorpayKeySecret } = req.body;
    const user = await User.findById(req.user!.id);

    if (!user) {
      return res.status(404).json({ message: "User not found" });
    }

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
});

router.get("/search-machine", auth, async (req: any, res: Response) => {
  try {
    const { q } = req.query;
    const userId = req.user!.id;
    const userRole = req.user!.role;
    
    if (!q || typeof q !== 'string' || q.trim() === '') {
      return res.json({ machines: [] });
    }
    
    let machines: any[] = [];
    const searchRegex = new RegExp(q, 'i');
    
    if (userRole === 'admin') {
      machines = await Machine.find({
        machineId: { $regex: searchRegex }
      }).limit(10).select('machineId location status assignedTo dealership');
      
    } else if (userRole === 'dealership') {
      const dealership = await User.findById(userId);
      if (dealership) {
        machines = await Machine.find({
          _id: { $in: dealership.assignedMachines || [] },
          machineId: { $regex: searchRegex }
        }).limit(10).select('machineId location status assignedTo');
      }
      
    } else if (userRole === 'customer') {
      machines = await Machine.find({
        assignedTo: userId,
        machineId: { $regex: searchRegex }
      }).limit(10).select('machineId location status dealership');
    }
    
    res.json({
      success: true,
      count: machines.length,
      machines: machines
    });
    
  } catch (err: any) {
    console.error("Search error:", err);
    res.status(500).json({ 
      success: false, 
      message: "Error searching machines",
      error: err.message 
    });
  }
});

router.get("/machine/:machineId", auth, async (req: any, res: Response) => {
  try {
    const { machineId } = req.params;
    const userId = req.user!.id;
    const userRole = req.user!.role;
    
    let machine = null;
    
    if (userRole === 'admin') {
      machine = await Machine.findOne({ machineId })
        .populate('assignedTo', 'name email phoneNumber')
        .populate('dealership', 'name email');
        
    } else if (userRole === 'dealership') {
      const dealership = await User.findById(userId);
      if (dealership) {
        machine = await Machine.findOne({
          machineId,
          _id: { $in: dealership.assignedMachines || [] }
        }).populate('assignedTo', 'name email phoneNumber');
      }
      
    } else if (userRole === 'customer') {
      machine = await Machine.findOne({
        machineId,
        assignedTo: userId
      });
    }
    
    if (!machine) {
      return res.status(404).json({ 
        success: false, 
        message: "Machine not found or you don't have access" 
      });
    }
    
    const logs = await Log.find({ machineId: machine.machineId })
      .sort({ date: -1 })
      .limit(30);
    
    res.json({
      success: true,
      machine: machine,
      recentLogs: logs
    });
    
  } catch (err: any) {
    console.error("Error fetching machine:", err);
    res.status(500).json({ 
      success: false, 
      message: "Error fetching machine details",
      error: err.message 
    });
  }
});

export default router;

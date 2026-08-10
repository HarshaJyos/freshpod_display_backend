// @ts-nocheck
import { Router, Response } from 'express';
import Machine from '../Model/machineSchema';
import User from '../Model/userSchema';
import Log from '../Model/logSchema';
import Payment from '../Model/paymentSchema';
import { auth, allowRoles } from '../middleware/auth';
const router = Router();

/* ======================================================
   HELPER FUNCTIONS
====================================================== */

// Normalize ObjectId
const normalizeId = (val: any) => {
  if (!val) return null;
  return typeof val === "object" ? val._id?.toString() : val.toString();
};

// Helper to compute total and monthly payments revenue
const getMachineRevenues = async (machineIds: string[]) => {
  if (!machineIds || machineIds.length === 0) return { totalMap: {}, monthlyMap: {} };

  const currentDate = new Date();
  const startOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
  const endOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0, 23, 59, 59);

  try {
    const totalAggregation = await Payment.aggregate([
      { 
        $match: { 
          machineId: { $in: machineIds }, 
          status: 'paid' 
        } 
      },
      { 
        $group: { 
          _id: '$machineId', 
          totalRevenue: { $sum: '$amount' } 
        } 
      }
    ]);

    const monthlyAggregation = await Payment.aggregate([
      { 
        $match: { 
          machineId: { $in: machineIds }, 
          status: 'paid',
          timestamp: { $gte: startOfMonth, $lte: endOfMonth }
        } 
      },
      { 
        $group: { 
          _id: '$machineId', 
          monthlyRevenue: { $sum: '$amount' } 
        } 
      }
    ]);

    const totalMap: { [key: string]: number } = {};
    totalAggregation.forEach((item: any) => {
      totalMap[item._id] = item.totalRevenue;
    });

    const monthlyMap: { [key: string]: number } = {};
    monthlyAggregation.forEach((item: any) => {
      monthlyMap[item._id] = item.monthlyRevenue;
    });

    return { totalMap, monthlyMap };
  } catch (err: any) {
    console.error("Error aggregating revenues:", err.message);
    return { totalMap: {}, monthlyMap: {} };
  }
};

// Format machine response
const formatMachineResponse = (machine: any, logsMap: any = {}, totalRevenueMap: any = {}, monthlyRevenueMap: any = {}) => ({
  _id: machine._id.toString(),
  machineId: machine.machineId,
  location: machine.location,
  state: machine.state,
  country: machine.country,
  totalTaps: machine.totalTaps || 0,
  costPerTap: machine.costPerTap || 70,
  status: machine.status || "active",
  assignedTo: normalizeId(machine.assignedTo),
  dealership: normalizeId(machine.dealership),
  razorpayKeyId: machine.razorpayKeyId || "",
  razorpayKeySecret: machine.razorpayKeySecret || "",
  logs: logsMap[machine.machineId] || {},
  totalRevenue: totalRevenueMap[machine.machineId] || 0,
  monthlyRevenue: monthlyRevenueMap[machine.machineId] || 0,
  createdAt: machine.createdAt,
  updatedAt: machine.updatedAt
});

// Get machines by role
const getMachinesByRole = async (user: any) => {
  if (user.role === "admin") return await Machine.find();
  if (user.role === "customer") return await Machine.find({ assignedTo: user.id });
  if (user.role === "dealership") {
    return await Machine.find({ dealership: user.id });
  }
  return [];
};

// FIXED: Properly aggregate logs by date (sum tapCounts for same date)
const getLogsMap = async (machineIds: any) => {
  if (!machineIds || machineIds.length === 0) return {};
  
  // Find all logs for the given machine IDs
  const logs = await Log.find({ machineId: { $in: machineIds } });
  
  const logsMap = {};
  
  // Aggregate tapCounts by machineId and date
  logs.forEach((log: any) => {
    if (!logsMap[log.machineId]) {
      logsMap[log.machineId] = {};
    }
    
    // Sum tapCounts for the same date
    if (logsMap[log.machineId][log.date]) {
      logsMap[log.machineId][log.date].tapCount += log.tapCount;
    } else {
      logsMap[log.machineId][log.date] = { tapCount: log.tapCount };
    }
  });
  
  return logsMap;
};

// Alternative: Using MongoDB aggregation for better performance
const getLogsMapAggregated = async (machineIds: any) => {
  if (!machineIds || machineIds.length === 0) return {};
  
  const aggregation = await Log.aggregate([
    {
      $match: { machineId: { $in: machineIds } }
    },
    {
      $group: {
        _id: {
          machineId: "$machineId",
          date: "$date"
        },
        totalTapCount: { $sum: "$tapCount" }
      }
    },
    {
      $group: {
        _id: "$_id.machineId",
        logs: {
          $push: {
            date: "$_id.date",
            tapCount: "$totalTapCount"
          }
        }
      }
    }
  ]);
  
  const logsMap = {};
  aggregation.forEach((item: any) => {
    logsMap[item._id] = {};
    item.logs.forEach((log: any) => {
      logsMap[item._id][log.date] = { tapCount: log.tapCount };
    });
  });
  
  return logsMap;
};

/* ======================================================
   GET MACHINE DATA
====================================================== */
router.get("/machine/data", auth, allowRoles("admin", "customer", "dealership"), async (req: any, res: Response) => {
  try {
    const machines = await getMachinesByRole(req.user);
    const machineIds = machines.map((m: any) => m.machineId);
    const logsMap = await getLogsMap(machineIds); // Using the fixed version
    const { totalMap, monthlyMap } = await getMachineRevenues(machineIds);

    const response = machines.map((m: any) => formatMachineResponse(m, logsMap, totalMap, monthlyMap));
    res.json(response);
  } catch (err: any) {
    console.error("Error in /machine/data:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   GET USERS
====================================================== */
router.get("/users", auth, allowRoles("admin", "dealership"), async (req: any, res: Response) => {
  try {
    let query = {};

    if (req.user.role === "dealership") {
      query = { parent: req.user.id, role: "customer" };
    }

    const users = await User.find(query)
      .select("-password -refreshToken")
      .populate("assignedMachines", "machineId location status");

    res.json(users);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   GET AVAILABLE MACHINES
====================================================== */
router.get("/user/:id/available-machines", auth, allowRoles("admin"), async (req: any, res: Response) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) return res.status(404).json({ message: "User not found" });

    const currentMachines = await Machine.find({
      _id: { $in: user.assignedMachines || [] }
    }).select("_id machineId location");

    let availableMachines = [];

    if (user.role === "dealership") {
      availableMachines = await Machine.find({
        dealership: null,
        assignedTo: null
      }).select("_id machineId location");
    }

    if (user.role === "customer") {
      availableMachines = await Machine.find({
        dealership: user.parent,
        assignedTo: null
      }).select("_id machineId location");
    }

    res.json({
      currentMachines,
      availableMachines
    });

  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   CREATE MACHINE
====================================================== */
router.post("/machine", auth, allowRoles("admin"), async (req: any, res: Response) => {
  try {
    const { machineId, location, state, country, costPerTap, machineCost, status, razorpayKeyId, razorpayKeySecret } = req.body;

    if (!machineId || !location || !state) {
      return res.status(400).json({ message: "Missing fields" });
    }

    const exists = await Machine.findOne({ machineId });
    if (exists) return res.status(400).json({ message: "Machine exists" });

    const machine = await Machine.create({
      machineId,
      location,
      state,
      country: country || "India",
      costPerTap: costPerTap || 0.50,
      machineCost: machineCost || 100,
      status: status || "active",
      assignedTo: null,
      dealership: null,
      razorpayKeyId: razorpayKeyId || "",
      razorpayKeySecret: razorpayKeySecret || ""
    });

    res.status(201).json(machine);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   UPDATE MACHINE
====================================================== */
router.put("/machine/:id", auth, allowRoles("admin"), async (req: any, res: Response) => {
  try {
    const { id } = req.params;
    const { machineId, location, state, country, costPerTap, machineCost, status, razorpayKeyId, razorpayKeySecret } = req.body;

    const machine = await Machine.findById(id);
    if (!machine) {
      return res.status(404).json({ message: "Machine not found" });
    }

    if (machineId) machine.machineId = machineId;
    if (location !== undefined) machine.location = location;
    if (state !== undefined) machine.state = state;
    if (country !== undefined) machine.country = country;
    if (costPerTap !== undefined) machine.costPerTap = costPerTap;
    if (machineCost !== undefined) machine.machineCost = machineCost;
    if (status !== undefined) machine.status = status;
    if (razorpayKeyId !== undefined) machine.razorpayKeyId = razorpayKeyId;
    if (razorpayKeySecret !== undefined) machine.razorpayKeySecret = razorpayKeySecret;

    await machine.save();
    res.json(machine);
  } catch (err: any) {
    console.error("Error updating machine:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   RECORD TAP (NEW ENDPOINT)
====================================================== */
router.post("/machine/:machineId/tap", auth, async (req: any, res: Response) => {
  try {
    const { machineId } = req.params;
    const { tapCount, amount, initiatedBy, sessionId } = req.body;
    
    const today = new Date().toISOString().split('T')[0];
    
    // Find the machine
    const machine = await Machine.findOne({ machineId });
    if (!machine) {
      return res.status(404).json({ message: "Machine not found" });
    }
    
    // Create log entry
    const log = await Log.create({
      machineId,
      date: today,
      tapCount: tapCount || 1,
      action: "TAP_DISPENSED",
      status: "completed",
      initiatedBy: initiatedBy || req.user.id,
      amount: amount || machine.costPerTap,
      sessionId: sessionId || `session_${Date.now()}`,
      sessionDuration: 0,
      sessionTaps: tapCount || 1,
      timestamp: new Date(),
      createdAt: new Date(),
      updatedAt: new Date()
    });
    
    // Update machine totalTaps
    machine.totalTaps = (machine.totalTaps || 0) + (tapCount || 1);
    await machine.save();
    
    res.status(201).json({
      success: true,
      message: "Tap recorded successfully",
      log,
      machine: {
        machineId: machine.machineId,
        totalTaps: machine.totalTaps
      }
    });
  } catch (err: any) {
    console.error("Error recording tap:", err);
    res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   GET MACHINE LOGS WITH AGGREGATION
====================================================== */
router.get("/machine/:machineId/logs", auth, async (req: any, res: Response) => {
  try {
    const { machineId } = req.params;
    
    const logs = await Log.find({ machineId }).sort({ date: -1 });
    
    // Aggregate by date
    const aggregatedLogs = {};
    logs.forEach((log: any) => {
      if (!aggregatedLogs[log.date]) {
        aggregatedLogs[log.date] = 0;
      }
      aggregatedLogs[log.date] += log.tapCount;
    });
    
    const machine = await Machine.findOne({ machineId });
    
    res.json({
      machineId,
      machineTotalTaps: machine?.totalTaps || 0,
      logs: logs,
      aggregatedLogs: aggregatedLogs,
      totalTapsFromLogs: Object.values(aggregatedLogs).reduce((a, b) => a + b, 0)
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   CREATE USER
====================================================== */
router.post("/createUser", auth, allowRoles("admin"), async (req: any, res: Response) => {
  try {
    const { name, email, phoneNumber , location , state, role, assignedMachineIds = [], razorpayKeyId, razorpayKeySecret } = req.body;

    // Validate role
    const validRoles = ["admin", "dealership", "operator", "customer"];
    if (!validRoles.includes(role)) {
      return res.status(400).json({ error: "Invalid role specified" });
    }

    // Check if phone number already exists
    const existingUserByPhone = await User.findOne({ phoneNumber });
    if (existingUserByPhone) {
      return res.status(400).json({ 
        error: "DUPLICATE_PHONE_NUMBER",
        message: "This mobile number is already registered with another account"
      });
    }

    // Check if email already exists
    const existingUserByEmail = await User.findOne({ email });
    if (existingUserByEmail) {
      return res.status(400).json({ 
        error: "DUPLICATE_EMAIL",
        message: "This email is already registered with another account"
      });
    }

    // Check if assigned machines exist and are available
    if (assignedMachineIds.length > 0) {
      const machines = await Machine.find({ _id: { $in: assignedMachineIds } });
      
      if (machines.length !== assignedMachineIds.length) {
        return res.status(400).json({ 
          error: "INVALID_MACHINES",
          message: "Some machines do not exist in the system" 
        });
      }
      
      // Check which machines are already assigned
      const alreadyAssigned = machines.filter(m => m.assignedTo !== null);
      if (alreadyAssigned.length > 0) {
        return res.status(400).json({ 
          error: "MACHINES_ALREADY_ASSIGNED",
          message: "Some machines are already assigned to other users",
          assignedMachines: alreadyAssigned.map((m: any) => ({
            machineId: m.machineId,
            currentAssignedTo: m.assignedTo
          }))
        });
      }
    }

    // Create the user
    const user = await User.create({
      name,
      email,
      phoneNumber,
      state,
      location,
      role,
      parent: req.user.id,
      assignedMachines: [],
      razorpayKeyId: razorpayKeyId || '',
      razorpayKeySecret: razorpayKeySecret || ''
    });

    // Assign machines based on role
    if (assignedMachineIds.length > 0) {
      const updateData = {};
      
      switch (role) {
        case "dealership":
          updateData.dealership = user._id;
          break;
        case "operator":
          updateData.operatorId = user._id;
          break;
        case "customer":
          updateData.assignedTo = user._id;
          break;
      }

      if (Object.keys(updateData).length > 0) {
        await Machine.updateMany(
          { _id: { $in: assignedMachineIds } },
          updateData
        );
      }
      
      user.assignedMachines = assignedMachineIds;
      await user.save();
    }

    const populatedUser = await User.findById(user._id)
      .select("-password")
      .populate('assignedMachines', 'machineId location status totalTaps');

    res.status(201).json({
      success: true,
      message: "User created successfully",
      user: populatedUser
    });

  } catch (err: any) {
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern)[0];
      return res.status(400).json({ 
        error: "DUPLICATE_ENTRY",
        message: `${field} already exists in the system`
      });
    }
    
    console.error("Error creating user:", err);
    res.status(500).json({ 
      error: "INTERNAL_SERVER_ERROR",
      message: err.message 
    });
  }
});

/* ======================================================
   UPDATE MACHINE
====================================================== */
router.put("/machine/:id", auth, allowRoles("admin"), async (req: any, res: Response) => {
  try {
    const { id } = req.params;
    const { machineId, location, state, country, costPerTap, machineCost, status } = req.body;

    const machine = await Machine.findById(id);
    if (!machine) {
      return res.status(404).json({ message: "Machine not found" });
    }

    if (machineId && machineId !== machine.machineId) {
      const exists = await Machine.findOne({ machineId });
      if (exists) {
        return res.status(400).json({ message: "Machine ID already exists" });
      }
    }

    machine.machineId = machineId || machine.machineId;
    machine.location = location || machine.location;
    machine.state = state || machine.state;
    machine.country = country || machine.country;
    machine.costPerTap = costPerTap || machine.costPerTap;
    machine.machineCost = machineCost || machine.machineCost;
    machine.status = status || machine.status;

    await machine.save();

    res.json(machine);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   UPDATE USER
====================================================== */
router.put("/user/:id", auth, allowRoles("admin"), async (req: any, res: Response) => {
  try {
    const { name, phoneNumber, location, state, country, assignedMachineIds = [], role, razorpayKeyId, razorpayKeySecret } = req.body;
    const user = await User.findById(req.params.id);

    if (!user) return res.status(404).json({ message: "User not found" });

    if (name !== undefined) user.name = name;
    if (phoneNumber !== undefined) user.phoneNumber = phoneNumber;
    if (location !== undefined) user.location = location;
    if (state !== undefined) user.state = state;
    if (country !== undefined) user.country = country;
    if (role !== undefined) user.role = role;
    if (razorpayKeyId !== undefined) user.razorpayKeyId = razorpayKeyId;
    if (razorpayKeySecret !== undefined) user.razorpayKeySecret = razorpayKeySecret;

    // Get current assigned machine IDs
    const currentIds = user.assignedMachines.map(id => id.toString());
    const newIds = assignedMachineIds.map(id => id.toString());

    const toRemove = currentIds.filter(id => !newIds.includes(id));
    const toAdd = newIds.filter(id => !currentIds.includes(id));

    // Handle removal of machines
    if (toRemove.length) {
      const updateData = {};
      
      // Clear the appropriate field based on user role
      if (user.role === "dealership") {
        updateData.dealership = null;
      } else if (user.role === "operator") {
        updateData.operatorId = null;
      } else if (user.role === "customer") {
        updateData.assignedTo = null;
      }
      
      await Machine.updateMany(
        { _id: { $in: toRemove } },
        updateData
      );
    }

    // Handle addition of machines
    if (toAdd.length) {
      // Check if machines exist and are available
      const validMachines = await Machine.find({
        _id: { $in: toAdd }
      });

      if (validMachines.length !== toAdd.length) {
        return res.status(400).json({ 
          error: "INVALID_MACHINES",
          message: "Some machines do not exist in the system" 
        });
      }

      // Check which machines are already assigned
      const alreadyAssigned = validMachines.filter(m => {
        if (user.role === "dealership") {
          return m.dealership !== null && m.dealership !== undefined;
        } else if (user.role === "operator") {
          return m.operatorId !== null && m.operatorId !== undefined;
        } else if (user.role === "customer") {
          return m.assignedTo !== null && m.assignedTo !== undefined;
        }
        return false;
      });

      if (alreadyAssigned.length > 0) {
        return res.status(400).json({ 
          error: "MACHINES_ALREADY_ASSIGNED",
          message: "Some machines are already assigned to other users",
          assignedMachines: alreadyAssigned.map((m: any) => ({
            machineId: m.machineId,
            currentAssignedTo: m.assignedTo || m.dealership || m.operatorId
          }))
        });
      }

      // Assign machines based on user role
      const updateData = {};
      
      switch (user.role) {
        case "dealership":
          updateData.dealership = user._id;
          break;
        case "operator":
          updateData.operatorId = user._id;
          break;
        case "customer":
          updateData.assignedTo = user._id;
          break;
        default:
          // For other roles, use assignedTo as fallback
          updateData.assignedTo = user._id;
      }

      await Machine.updateMany(
        { _id: { $in: validMachines.map((m: any) => m._id) } },
        updateData
      );
    }

    // Update user's assigned machines
    user.assignedMachines = assignedMachineIds;
    await user.save();

    // Return populated user data
    const updatedUser = await User.findById(user._id)
      .select("-password")
      .populate('assignedMachines', 'machineId location status totalTaps');

    res.json({
      success: true,
      message: "User updated successfully",
      user: updatedUser
    });

  } catch (err: any) {
    console.error("Error updating user:", err);
    res.status(500).json({ 
      error: "INTERNAL_SERVER_ERROR",
      message: err.message 
    });
  }
});


router.delete("/user/:id", auth, allowRoles("admin"), async (req: any, res: Response) => {
  try {
    const user = await User.findById(req.params.id);

    if (!user) {
      return res.status(404).json({ 
        error: "USER_NOT_FOUND",
        message: "User not found" 
      });
    }

    // Track which machines will be affected for the response
    let affectedMachines = [];
    let updateResult = {};

    // Clear machine assignments based on user role
    if (user.role === "dealership") {
      // Get affected machines
      affectedMachines = await Machine.find({ dealership: user._id });
      
      // Clear ALL assignments for dealership's machines
      updateResult = await Machine.updateMany(
        { dealership: user._id },
        { 
          $set: { 
            dealership: null,
            assignedTo: null,
            operatorId: null
          }
        }
      );
    } 
    else if (user.role === "customer") {
      // Get affected machines
      affectedMachines = await Machine.find({ assignedTo: user._id });
      
      // Clear assignments for customer's machines
      updateResult = await Machine.updateMany(
        { assignedTo: user._id },
        { 
          $set: { 
            assignedTo: null,
            operatorId: null
          }
        }
      );
    }
    else if (user.role === "operator") {
      // Get affected machines
      affectedMachines = await Machine.find({ operatorId: user._id });
      
      // Clear operator assignment
      updateResult = await Machine.updateMany(
        { operatorId: user._id },
        { 
          $set: { 
            operatorId: null
          }
        }
      );
    }
    else if (user.role === "admin") {
      // Admins usually don't have machines assigned, but just in case
      affectedMachines = await Machine.find({ 
        $or: [
          { dealership: user._id },
          { assignedTo: user._id },
          { operatorId: user._id }
        ]
      });
      
      updateResult = await Machine.updateMany(
        { 
          $or: [
            { dealership: user._id },
            { assignedTo: user._id },
            { operatorId: user._id }
          ]
        },
        { 
          $set: { 
            dealership: null,
            assignedTo: null,
            operatorId: null
          }
        }
      );
    }
    else {
      // Fallback for any other roles
      affectedMachines = await Machine.find({ assignedTo: user._id });
      
      updateResult = await Machine.updateMany(
        { assignedTo: user._id },
        { 
          $set: { 
            assignedTo: null,
            operatorId: null,
            dealership: null
          }
        }
      );
    }

    // Also clean up any references in the user's assignedMachines array
    // This ensures the user document is clean before deletion
    user.assignedMachines = [];
    await user.save();

    // Store user data for response before deletion
    const userData = {
      id: user._id,
      name: user.name,
      email: user.email,
      role: user.role,
      phoneNumber: user.phoneNumber
    };

    // Delete the user
    await user.deleteOne();

    // Log the deletion for audit purposes
    console.log(`User deleted by ${req.user.id}:`, {
      deletedUser: userData,
      affectedMachines: affectedMachines.length,
      machinesUpdated: updateResult.modifiedCount || 0,
      timestamp: new Date().toISOString()
    });

    res.json({
      success: true,
      message: "User deleted successfully. All machine references cleared.",
      data: {
        deletedUser: userData,
        machinesAffected: affectedMachines.map((m: any) => ({
          id: m._id,
          machineId: m.machineId,
          location: m.location
        })),
        totalMachinesUpdated: updateResult.modifiedCount || 0
      }
    });

  } catch (err: any) {
    console.error("Error deleting user:", err);
    res.status(500).json({ 
      error: "INTERNAL_SERVER_ERROR",
      message: err.message 
    });
  }
});

/* ======================================================
   DATA CONSISTENCY CHECK (DEBUG ENDPOINT)
====================================================== */
router.get("/debug/consistency", auth, allowRoles("admin"), async (req: any, res: Response) => {
  try {
    const machines = await Machine.find();
    const results = [];
    
    for (const machine of machines) {
      const logs = await Log.find({ machineId: machine.machineId });
      const calculatedTotal = logs.reduce((sum: any, log: any) => sum + log.tapCount, 0);
      
      results.push({
        machineId: machine.machineId,
        storedTotalTaps: machine.totalTaps,
        calculatedTotalFromLogs: calculatedTotal,
        logsCount: logs.length,
        isConsistent: machine.totalTaps === calculatedTotal,
        discrepancy: machine.totalTaps - calculatedTotal
      });
    }
    
    res.json({
      totalMachines: machines.length,
      consistentMachines: results.filter(r => r.isConsistent).length,
      inconsistentMachines: results.filter(r => !r.isConsistent).length,
      details: results
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   FIX INCONSISTENT DATA (ADMIN ONLY)
====================================================== */
router.post("/debug/fix-consistency", auth, allowRoles("admin"), async (req: any, res: Response) => {
  try {
    const machines = await Machine.find();
    const fixes = [];
    
    for (const machine of machines) {
      const logs = await Log.find({ machineId: machine.machineId });
      const calculatedTotal = logs.reduce((sum: any, log: any) => sum + log.tapCount, 0);
      
      if (machine.totalTaps !== calculatedTotal) {
        const oldTotal = machine.totalTaps;
        machine.totalTaps = calculatedTotal;
        await machine.save();
        
        fixes.push({
          machineId: machine.machineId,
          oldTotalTaps: oldTotal,
          newTotalTaps: calculatedTotal,
          fixed: true
        });
      }
    }
    
    res.json({
      message: "Data consistency fix completed",
      fixes: fixes,
      totalFixed: fixes.length
    });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

/* ======================================================
   PAYMENTS HISTORY WITH ROLE-BASED FILTERING
====================================================== */
router.get("/payments/history", auth, allowRoles("admin", "dealership", "customer", "operator"), async (req: any, res: Response) => {
  try {
    const { role, id } = req.user;

    let query: any = {};
    let shouldFilterSensitiveData = true;

    if (role === "admin") {
      // Admins see all payments and full sensitive details
      query = {};
      shouldFilterSensitiveData = false;
    } else {
      // Find machines assigned to this user
      const user = await User.findById(id).populate("assignedMachines", "machineId");
      if (!user) {
        return res.status(404).json({ message: "User profile not found" });
      }

      // Collect machineId strings (e.g. ['FP_MACHINE_01', 'FP_MACHINE_02'])
      const assignedMachineIds = (user.assignedMachines || []).map((m: any) => m.machineId);
      
      // Filter payments by these machine IDs
      query = { machineId: { $in: assignedMachineIds } };
      shouldFilterSensitiveData = true;
    }

    const payments = await Payment.find(query).sort({ timestamp: -1 });

    // Calculate aggregations
    let totalAmount = 0;
    let mqttAmount = 0;
    let razorpayAmount = 0;

    const formattedPayments = payments.map((payment: any) => {
      const amt = payment.amount || 0;
      totalAmount += amt;
      if (payment.method === "MQTT") {
        mqttAmount += amt;
      } else if (payment.method === "Razorpay") {
        razorpayAmount += amt;
      }

      // Exclude customer details if user is not admin
      return {
        _id: payment._id.toString(),
        paymentId: payment.paymentId,
        qrId: payment.qrId,
        machineId: payment.machineId,
        amount: amt,
        method: payment.method,
        status: payment.status,
        timestamp: payment.timestamp,
        customerName: shouldFilterSensitiveData ? undefined : payment.customerName,
        customerEmail: shouldFilterSensitiveData ? undefined : payment.customerEmail,
        customerPhone: shouldFilterSensitiveData ? undefined : payment.customerPhone
      };
    });

    res.json({
      success: true,
      summary: {
        totalAmount,
        mqttAmount,
        razorpayAmount,
        count: formattedPayments.length
      },
      payments: formattedPayments
    });

  } catch (err: any) {
    console.error("Error fetching payment history:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
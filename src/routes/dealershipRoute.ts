// @ts-nocheck
import { Router, Response } from 'express';
import Machine from '../Model/machineSchema';
import User from '../Model/userSchema';
import Log from '../Model/logSchema';
import { auth, allowRoles } from '../middleware/auth';
// routes/dealershipRoute.js
const router = Router();


// ======================================================
// GET MACHINES FOR DEALERSHIP
// ======================================================
// ======================================================
// CREATE CUSTOMER (For Dealership)
// ======================================================
router.post("/create-customer", auth, allowRoles("dealership"), async (req: any, res: Response) => {
  try {
    const {
      name,
      phoneNumber,
      email,
      location,
      assignedMachineIds = []
    } = req.body;

    console.log("Create customer request:", { name, email, assignedMachineIds });

    // Validate required fields
    if (!name || !phoneNumber || !email || !location) {
      return res.status(400).json({ 
        message: "Missing required fields: name, phoneNumber, email, and location are required" 
      });
    }

    // Check if user already exists
    const exists = await User.findOne({ email });
    if (exists) {
      return res.status(400).json({ message: "User already exists" });
    }

    // Get the dealership (parent user)
    const parentUser = await User.findById(req.user.id);
    if (!parentUser) {
      return res.status(404).json({ message: "Dealership not found" });
    }

    // Customer inherits state and country from dealership
    const finalState = parentUser.state;
    const finalCountry = parentUser.country;

    // Validate machines - only get machines that:
    // 1. Belong to this dealership (dealership field matches)
    // 2. Are not assigned to any customer yet (assignedTo is null)
    let validatedMachines: any[] = [];
    if (assignedMachineIds && assignedMachineIds.length > 0) {
      validatedMachines = await Machine.find({
        _id: { $in: assignedMachineIds },
        dealership: parentUser._id,  // Machine must belong to this dealership
        assignedTo: null              // Machine not sold yet
      });

      if (validatedMachines.length !== assignedMachineIds.length) {
        return res.status(400).json({
          message: "Some machines are invalid, not owned by you, or already sold"
        });
      }
    }

    // Create customer user
    const customer = await User.create({
      name,
      phoneNumber,
      email,
      location: location,
      state: finalState,
      country: finalCountry,
      role: "customer",
      parent: parentUser._id,
      assignedMachines: validatedMachines.map((m: any) => m._id)
    });

    // Assign machines to the customer (set assignedTo field)
    if (validatedMachines.length > 0) {
      await Machine.updateMany(
        { _id: { $in: validatedMachines.map((m: any) => m._id) } },
        { $set: { assignedTo: customer._id } }
      );
    }

    // Return customer without sensitive data
    const customerResponse = customer.toObject();
    delete customerResponse.password;
    delete customerResponse.refreshToken;

    res.status(201).json({ 
      message: "Customer created successfully", 
      user: customerResponse 
    });

  } catch (err: any) {
    console.error("Error creating customer:", err);
    res.status(500).json({ error: err.message });
  }
});

router.get("/machines", auth, allowRoles("dealership"), async (req: any, res: Response) => {
  try {
    const dealershipId = req.user.id;
    const dealership = await User.findById(dealershipId);

    if (!dealership) {
      return res.status(404).json({ message: "Dealership not found" });
    }

    // Get machines from assignedMachines array
    const machines = await Machine.find({
      _id: { $in: dealership.assignedMachines || [] }
    }).populate('assignedTo', 'name email phoneNumber');

    res.json({
      count: machines.length,
      machines
    });

  } catch (err: any) {
    console.error("Error fetching dealership machines:", err);
    res.status(500).json({ error: err.message });
  }
});

// ======================================================
// GET MACHINE DATA WITH LOGS FOR DEALERSHIP
// ======================================================
router.get("/machine/data", auth, allowRoles("dealership"), async (req: any, res: Response) => {
  try {
    const dealershipId = req.user.id;
    const dealership = await User.findById(dealershipId);
    
    if (!dealership) {
      return res.status(404).json({ message: "Dealership not found" });
    }
    
    // Get machines from assignedMachines array
    const machines = await Machine.find({
      _id: { $in: dealership.assignedMachines || [] }
    });
    
    const machineIds = machines.map((m: any) => m.machineId);
    const logs = await Log.find({ machineId: { $in: machineIds } });

    const logsMap = {};
    logs.forEach((log: any) => {
      if (!logsMap[log.machineId]) logsMap[log.machineId] = {};
      logsMap[log.machineId][log.date] = { tapCount: log.tapCount };
    });

    const response = machines.map((machine: any) => ({
      machineData: {
        _id: machine._id,
        machineId: machine.machineId,
        location: machine.location,
        state: machine.state,
        country: machine.country,
        machineCost: machine.machineCost,
        costPerTap: machine.costPerTap,
        totalTaps: machine.totalTaps || 0,
        status: machine.status,
        dealership: machine.dealership,
        assignedTo: machine.assignedTo,
        createdAt: machine.createdAt,
        updatedAt: machine.updatedAt
      },
      logs: logsMap[machine.machineId] || {}
    }));

    res.json(response);
  } catch (err: any) {
    console.error("Error fetching dealership machine data:", err);
    res.status(500).json({ error: err.message });
  }
});


// routes/dealershipRoute.js - FIXED dashboard endpoint
router.get("/dashboard", auth, allowRoles("dealership"), async (req: any, res: Response) => {
  try {
    const dealerId = req.user.id;
    const dealership = await User.findById(dealerId);

    if (!dealership) {
      return res.status(404).json({ message: "Dealership not found" });
    }

    const machineIds = dealership.assignedMachines || [];
    
    // Total machines assigned to this dealership
    const totalMachines = machineIds.length;

    // Sold machines (assigned to customers)
    const soldMachines = await Machine.countDocuments({
      _id: { $in: machineIds },
      assignedTo: { $ne: null }
    });

    // Available machines (not sold yet)
    const availableMachines = await Machine.countDocuments({
      _id: { $in: machineIds },
      assignedTo: null
    });

    // PROFIT: ₹40,000 per machine sold (NOT the machine cost)
    const PROFIT_PER_MACHINE = 40000;
    const totalProfit = soldMachines * PROFIT_PER_MACHINE;

    console.log("Dealership Stats:", {
      totalMachines,
      soldMachines,
      availableMachines,
      totalProfit,
      profitPerMachine: PROFIT_PER_MACHINE
    });

    res.json({
      totalMachines,
      soldMachines,
      availableMachines,
      totalProfit,
      profitPerMachine: PROFIT_PER_MACHINE
    });

  } catch (err: any) {
    console.error("Error fetching dealership dashboard:", err);
    res.status(500).json({ error: err.message });
  }
});

// ======================================================
// GET CUSTOMERS (Users created by this dealership)
// ======================================================
router.get("/customers", auth, allowRoles("dealership"), async (req: any, res: Response) => {
  try {
    const dealershipId = req.user.id;
    
    const customers = await User.find({
      parent: dealershipId,
      role: "customer"
    }).select("-password -refreshToken").populate('assignedMachines');

    res.json(customers);
  } catch (err: any) {
    console.error("Error fetching customers:", err);
    res.status(500).json({ error: err.message });
  }
});

// ======================================================
// UPDATE MACHINE COST PER TAP
// ======================================================
router.put("/machine/:id/cost", auth, allowRoles("dealership"), async (req: any, res: Response) => {
  try {
    const { costPerTap } = req.body;
    const machineId = req.params.id;
    const dealershipId = req.user.id;
    
    const dealership = await User.findById(dealershipId);

    if (costPerTap === undefined) {
      return res.status(400).json({ message: "costPerTap is required" });
    }

    if (costPerTap < 0) {
      return res.status(400).json({ message: "Invalid costPerTap" });
    }

    // Check if machine belongs to this dealership
    if (!dealership.assignedMachines.includes(machineId)) {
      return res.status(403).json({ message: "Machine not owned by you" });
    }

    const machine = await Machine.findById(machineId);
    if (!machine) {
      return res.status(404).json({ message: "Machine not found" });
    }

    machine.costPerTap = costPerTap;
    await machine.save();

    res.json({ message: "Cost per tap updated", machine });
  } catch (err: any) {
    console.error("Error updating cost per tap:", err);
    res.status(500).json({ error: err.message });
  }
});

// ======================================================
// GET MACHINE ANALYTICS FOR DEALERSHIP
// ======================================================
router.get("/analytics", auth, allowRoles("dealership"), async (req: any, res: Response) => {
  try {
    const dealershipId = req.user.id;
    const dealership = await User.findById(dealershipId);
    
    if (!dealership) {
      return res.status(404).json({ message: "Dealership not found" });
    }
    
    const machineIds = dealership.assignedMachines || [];
    const machines = await Machine.find({ _id: { $in: machineIds } });
    const machineIdStrings = machines.map((m: any) => m.machineId);
    
    const logs = await Log.find({ machineId: { $in: machineIdStrings } });
    
    // Calculate analytics
    const totalTaps = logs.reduce((acc: any, log: any) => acc + (log.tapCount || 0), 0);
    const totalRevenue = machines.reduce((acc: any, m: any) => acc + ((m.totalTaps || 0) * (m.costPerTap || 0.50)), 0);
    
    // Group by date
    const dailyData = {};
    logs.forEach((log: any) => {
      dailyData[log.date] = (dailyData[log.date] || 0) + (log.tapCount || 0);
    });
    
    const dailyTrend = Object.entries(dailyData)
      .sort((a, b) => new Date(a[0]) - new Date(b[0]))
      .slice(-30)
      .map(([date, taps]) => ({ date, taps }));
    
    res.json({
      totalTaps,
      totalRevenue,
      totalMachines: machines.length,
      soldMachines: machines.filter(m => m.assignedTo).length,
      availableMachines: machines.filter(m => !m.assignedTo).length,
      dailyTrend
    });
  } catch (err: any) {
    console.error("Error fetching analytics:", err);
    res.status(500).json({ error: err.message });
  }
});


// Add this to your dealershipRoute.js to ensure only unassigned machines are returned
router.get("/available-machines", auth, allowRoles("dealership"), async (req: any, res: Response) => {
  try {
    const dealershipId = req.user.id;
    const dealership = await User.findById(dealershipId);
    
    if (!dealership) {
      return res.status(404).json({ message: "Dealership not found" });
    }
    
    // Get only machines that:
    // 1. Belong to this dealership
    // 2. Are NOT assigned to any customer (assignedTo = null)
    const availableMachines = await Machine.find({
      _id: { $in: dealership.assignedMachines || [] },
      assignedTo: null  // Only show unassigned machines
    });
    
    res.json({
      count: availableMachines.length,
      machines: availableMachines
    });
    
  } catch (err: any) {
    console.error("Error fetching available machines:", err);
    res.status(500).json({ error: err.message });
  }
});

export default router;
// @ts-nocheck
import { Router, Response } from 'express';
import Machine from '../Model/machineSchema';
import User from '../Model/userSchema';
import Log from '../Model/logSchema';
import Report from '../Model/reportSchema';
import CustomerMachineSettings from '../Model/customerMachineSettingsSchema';
import Payment from '../Model/paymentSchema';
import { auth, allowRoles } from '../middleware/auth';
// routes/customerRoutes.js - COMPLETE FIXED VERSION

const router = Router();


// ======================================================
// HELPER FUNCTIONS
// ======================================================

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

// Get total taps for a machine from TAP_DISPENSED logs
const getMachineTotalTaps = async (machineId) => {
  try {
    const result = await Log.aggregate([
      { 
        $match: { 
          machineId: machineId,
          action: "TAP_DISPENSED"
        } 
      },
      { 
        $group: { 
          _id: null, 
          total: { $sum: "$tapCount" } 
        } 
      }
    ]);
    return result.length > 0 ? result[0].total : 0;
  } catch (error: any) {
    console.error(`Error getting total taps for ${machineId}:`, error);
    return 0;
  }
};

// Get monthly taps for a machine
const getMachineMonthlyTaps = async (machineId, year, month) => {
  try {
    const monthStr = String(month).padStart(2, '0');
    const dateRegex = `${year}-${monthStr}`;
    
    const result = await Log.aggregate([
      { 
        $match: { 
          machineId: machineId,
          action: "TAP_DISPENSED",
          date: { $regex: `^${dateRegex}` }
        } 
      },
      { 
        $group: { 
          _id: null, 
          total: { $sum: "$tapCount" } 
        } 
      }
    ]);
    return result.length > 0 ? result[0].total : 0;
  } catch (error: any) {
    console.error(`Error getting monthly taps for ${machineId}:`, error);
    return 0;
  }
};

// ======================================================
// GET CUSTOMER MACHINES WITH SETTINGS
// ======================================================
router.get("/machines", auth, allowRoles("customer"), async (req: any, res: Response) => {
  console.log("\n🟢 [GET /customer/machines] Request received");
  console.log("📌 User ID:", req.user.id);
  
  try {
    const customerId = req.user.id;
    
    const machines = await Machine.find({ 
      assignedTo: customerId 
    }).lean();
    
    console.log(`📊 Found ${machines.length} machines for customer`);
    
    if (!machines.length) {
      console.log("⚠️ No machines found, returning empty array");
      return res.json([]);
    }
    
    // Get customer settings
    const machineIds = machines.map((m: any) => m._id);
    const settings = await CustomerMachineSettings.find({ 
      customerId,
      machineId: { $in: machineIds }
    }).lean();
    
    const settingsMap = {};
    settings.forEach(s => {
      settingsMap[s.machineId.toString()] = s;
    });
    
    const currentDate = new Date();
    const currentYear = currentDate.getFullYear();
    const currentMonth = currentDate.getMonth() + 1;

    // Get combined payment revenues (Razorpay + MQTT)
    const machineIdStrings = machines.map((m: any) => m.machineId);
    const { totalMap, monthlyMap } = await getMachineRevenues(machineIdStrings);
    
    const response = await Promise.all(machines.map(async (machine) => {
      const machineSettings = settingsMap[machine._id.toString()];
      
      // Get actual taps from TAP_DISPENSED logs
      const totalTaps = await getMachineTotalTaps(machine.machineId);
      const monthlyTaps = await getMachineMonthlyTaps(machine.machineId, currentYear, currentMonth);
      
      const costPerTap = machineSettings?.costPerTap || machine.costPerTap || 0.50;
      const rentPerMonth = machineSettings?.rentPerMonth || 0;
      const maintenanceCost = machineSettings?.maintenanceCostPerMonth || 0;
      
      const monthlyRevenue = monthlyMap[machine.machineId] || 0;
      const totalRevenue = totalMap[machine.machineId] || 0;
      const netProfit = monthlyRevenue - (rentPerMonth + maintenanceCost);
      const profitMargin = monthlyRevenue > 0 ? (netProfit / monthlyRevenue) * 100 : 0;
      
      // Update machine totalTaps in database if different
      if (machine.totalTaps !== totalTaps) {
        console.log(`🔄 Updating machine ${machine.machineId} totalTaps from ${machine.totalTaps} to ${totalTaps}`);
        await Machine.updateOne(
          { _id: machine._id },
          { $set: { totalTaps: totalTaps } }
        ).catch(err => console.error("Error updating machine taps:", err));
      }
      
      console.log(`📊 Machine ${machine.machineId}: Total Taps=${totalTaps}, Monthly Taps=${monthlyTaps}, Revenue=${monthlyRevenue}, Profit=${netProfit}`);
      
      return {
        _id: machine._id,
        machineId: machine.machineId,
        location: machine.location || 'N/A',
        state: machine.state || 'N/A',
        country: machine.country || 'India',
        totalTaps: totalTaps,
        machineCost: machine.machineCost || 0,
        monthlyTaps: monthlyTaps,
        monthlyRevenue: monthlyRevenue,
        totalRevenue: totalRevenue,
        netProfit: netProfit,
        profitMargin: profitMargin.toFixed(2),
        status: machine.status || 'active',
        costPerTap: costPerTap,
        rentPerMonth: rentPerMonth,
        maintenanceCostPerMonth: maintenanceCost,
        assignedTo: machine.assignedTo,
        operatorId: machine.operatorId,
        createdAt: machine.createdAt,
        updatedAt: machine.updatedAt
      };
    }));
    
    console.log(`✅ Returning ${response.length} machines with calculated totals`);
    res.json(response);
    
  } catch (err: any) {
    console.error("❌ Error fetching customer machines:", err);
    res.status(500).json({ error: err.message });
  }
});

// ======================================================
// UPDATE COST PER TAP
// ======================================================
router.put("/machine/:id/cost", auth, allowRoles("customer"), async (req: any, res: Response) => {
  console.log("\n🟢 [PUT /customer/machine/:id/cost] Request received");
  console.log("📌 Machine ID:", req.params.id);
  console.log("📌 Cost Per Tap:", req.body.costPerTap);
  console.log("📌 Customer ID:", req.user.id);
  
  try {
    const { costPerTap } = req.body;
    const customerId = req.user.id;
    const machineId = req.params.id;
    
    // Validate input
    if (costPerTap === undefined || costPerTap === null) {
      console.log("❌ costPerTap is required");
      return res.status(400).json({ 
        success: false, 
        message: "costPerTap is required" 
      });
    }
    
    if (costPerTap < 0) {
      console.log("❌ costPerTap cannot be negative:", costPerTap);
      return res.status(400).json({ 
        success: false, 
        message: "costPerTap cannot be negative" 
      });
    }
    
    // Find and update the machine
    const updatedMachine = await Machine.findOneAndUpdate(
      { 
        _id: machineId,
        assignedTo: customerId,
        status: { $ne: "inactive" }
      },
      { 
        $set: { 
          costPerTap: costPerTap
        } 
      },
      { 
        returnDocument: 'after',  // ✅ Fixed: Use 'after' instead of 'new'
        runValidators: true,
        lean: true
      }
    );
    
    if (!updatedMachine) {
      console.log("❌ Machine not found or not owned by customer");
      return res.status(404).json({ 
        success: false, 
        message: "Machine not found or not assigned to you" 
      });
    }
    
    console.log(`✅ Cost per tap updated to ${costPerTap}`);
    console.log(`📊 Updated machine:`, updatedMachine);
    
    // ✅ Update CustomerMachineSettings if it exists
    try {
      const CustomerMachineSettings = mongoose.model('CustomerMachineSettings');
      await CustomerMachineSettings.findOneAndUpdate(
        { customerId, machineId: updatedMachine._id },
        { 
          costPerTap,
          machineCode: updatedMachine.machineId,
          updatedAt: new Date()
        },
        { upsert: true, new: true, returnDocument: 'after' }
      );
      console.log("✅ Customer settings updated");
    } catch (settingsError) {
      console.warn("⚠️ Could not update customer settings:", settingsError.message);
    }
    
    res.json({
      success: true,
      message: "Cost per tap updated successfully",
      data: { 
        machineId: updatedMachine.machineId,
        costPerTap: updatedMachine.costPerTap,
        status: updatedMachine.status
      }
    });
    
  } catch (err: any) {
    console.error("❌ Error updating cost:", err);
    res.status(500).json({ 
      success: false,
      error: "INTERNAL_SERVER_ERROR",
      message: err.message 
    });
  }
});

// ======================================================
// UPDATE RENT PER MONTH
// ======================================================
router.put("/machine/:id/rent", auth, allowRoles("customer"), async (req: any, res: Response) => {
  console.log("\n🟢 [PUT /customer/machine/:id/rent] Request received");
  console.log("📌 Machine ID:", req.params.id);
  console.log("📌 Rent Per Month:", req.body.rentPerMonth);
  
  try {
    const { rentPerMonth } = req.body;
    const customerId = req.user.id;
    const machineId = req.params.id;
    
    if (rentPerMonth === undefined || rentPerMonth < 0) {
      return res.status(400).json({ success: false, message: "Valid rentPerMonth is required" });
    }
    
    const machine = await Machine.findOne({
      _id: machineId,
      assignedTo: customerId
    });
    
    if (!machine) {
      return res.status(404).json({ success: false, message: "Machine not found" });
    }
    
    await CustomerMachineSettings.findOneAndUpdate(
      { customerId, machineId },
      { 
        rentPerMonth,
        machineCode: machine.machineId,
        updatedAt: Date.now()
      },
      { upsert: true, new: true }
    );

    


    
    res.json({
      success: true,
      message: "Rent updated successfully",
      data: { machineId: machine.machineId, rentPerMonth }
    });
    
  } catch (err: any) {
    console.error("Error updating rent:", err);
    res.status(500).json({ error: err.message });
  }
});

// ======================================================
// UPDATE MAINTENANCE COST
// ======================================================
router.put("/machine/:id/maintenance", auth, allowRoles("customer"), async (req: any, res: Response) => {
  console.log("\n🟢 [PUT /customer/machine/:id/maintenance] Request received");
  console.log("📌 Machine ID:", req.params.id);
  console.log("📌 Maintenance Cost:", req.body.maintenanceCostPerMonth);
  
  try {
    const { maintenanceCostPerMonth } = req.body;
    const customerId = req.user.id;
    const machineId = req.params.id;
    
    if (maintenanceCostPerMonth === undefined || maintenanceCostPerMonth < 0) {
      return res.status(400).json({ success: false, message: "Valid maintenance cost is required" });
    }
    
    const machine = await Machine.findOne({
      _id: machineId,
      assignedTo: customerId
    });
    
    if (!machine) {
      return res.status(404).json({ success: false, message: "Machine not found" });
    }
    
    await CustomerMachineSettings.findOneAndUpdate(
      { customerId, machineId },
      { 
        maintenanceCostPerMonth,
        machineCode: machine.machineId,
        updatedAt: Date.now()
      },
      { upsert: true, new: true }
    );
    
    res.json({
      success: true,
      message: "Maintenance cost updated successfully",
      data: { machineId: machine.machineId, maintenanceCostPerMonth }
    });
    
  } catch (err: any) {
    console.error("Error updating maintenance:", err);
    res.status(500).json({ error: err.message });
  }
});

// ======================================================
// GET DASHBOARD STATS
// ======================================================
router.get("/dashboard", auth, allowRoles("customer"), async (req: any, res: Response) => {
  console.log("\n🟢 [GET /customer/dashboard] Request received");
  console.log("📌 User ID:", req.user.id);
  
  try {
    const customerId = req.user.id;
    
    const machines = await Machine.find({ assignedTo: customerId }).lean();
    const operatorCount = await User.countDocuments({
      parent: customerId,
      role: "operator"
    });
    
    console.log(`📊 Machines: ${machines.length}, Operators: ${operatorCount}`);
    
    if (!machines.length) {
      return res.json({
        totalMachines: 0,
        activeMachines: 0,
        totalTapsMonth: 0,
        totalRevenueMonth: 0,
        avgDailyTaps: 0,
        totalOperators: operatorCount
      });
    }
    
    const currentDate = new Date();
    const currentYear = currentDate.getFullYear();
    const currentMonth = currentDate.getMonth() + 1;
    const monthStr = String(currentMonth).padStart(2, '0');
    const dateRegex = `${currentYear}-${monthStr}`;
    
    let totalTapsMonth = 0;
    let activeMachines = 0;

    // Get combined payment revenues (Razorpay + MQTT)
    const machineIdStrings = machines.map((m: any) => m.machineId);
    const { monthlyMap } = await getMachineRevenues(machineIdStrings);
    let totalRevenueMonth = 0;
    
    for (const machine of machines) {
      // Get monthly taps from TAP_DISPENSED logs
      const monthlyTapsResult = await Log.aggregate([
        {
          $match: {
            machineId: machine.machineId,
            action: "TAP_DISPENSED",
            date: { $regex: `^${dateRegex}` }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: "$tapCount" }
          }
        }
      ]);
      
      const machineMonthTaps = monthlyTapsResult.length > 0 ? monthlyTapsResult[0].total : 0;
      
      totalTapsMonth += machineMonthTaps;
      totalRevenueMonth += monthlyMap[machine.machineId] || 0;
      if (machineMonthTaps > 0) activeMachines++;
    }
    
    console.log(`✅ Dashboard stats: Taps: ${totalTapsMonth}, Revenue: ${totalRevenueMonth}, Active: ${activeMachines}`);
    
    res.json({
      totalMachines: machines.length,
      activeMachines,
      totalTapsMonth,
      totalRevenueMonth,
      avgDailyTaps: totalTapsMonth > 0 ? Math.round(totalTapsMonth / 30) : 0,
      totalOperators: operatorCount
    });
    
  } catch (err: any) {
    console.error("❌ Error fetching dashboard:", err);
    res.status(500).json({ error: err.message });
  }
});

// ======================================================
// GET MACHINE DETAILS WITH LOGS
// ======================================================
router.get("/machine/:machineId", auth, allowRoles("customer"), async (req: any, res: Response) => {
  console.log("\n🟢 [GET /customer/machine/:machineId] Request received");
  console.log("📌 Machine ID:", req.params.machineId);
  console.log("📌 Customer ID:", req.user.id);
  
  try {
    const { machineId } = req.params;
    const customerId = req.user.id;
    
    const machine = await Machine.findOne({
      machineId: machineId,
      assignedTo: customerId
    }).lean();
    
    if (!machine) {
      console.log("❌ Machine not found or not assigned to customer");
      return res.status(404).json({ 
        success: false, 
        message: "Machine not found" 
      });
    }
    
    console.log(`✅ Machine found: ${machine.machineId}`);
    
    // Get total taps from TAP_DISPENSED logs
    const totalTaps = await getMachineTotalTaps(machine.machineId);
    
    // Get monthly taps
    const currentDate = new Date();
    const currentYear = currentDate.getFullYear();
    const currentMonth = currentDate.getMonth() + 1;
    const monthlyTaps = await getMachineMonthlyTaps(machine.machineId, currentYear, currentMonth);
    
    const settings = await CustomerMachineSettings.findOne({
      customerId,
      machineId: machine._id
    }).lean();
    
    const costPerTap = settings?.costPerTap || machine.costPerTap || 0.50;
    const rentPerMonth = settings?.rentPerMonth || 0;
    const maintenanceCost = settings?.maintenanceCostPerMonth || 0;
    const monthlyRevenue = monthlyTaps * costPerTap;
    const netProfit = monthlyRevenue - (rentPerMonth + maintenanceCost);
    
    // Get recent logs
    const recentLogs = await Log.find({ 
      machineId: machine.machineId,
      action: "TAP_DISPENSED"
    })
    .sort({ date: -1, timestamp: -1 })
    .limit(20)
    .lean();
    
    // Update machine totalTaps if needed
    if (machine.totalTaps !== totalTaps) {
      console.log(`🔄 Updating machine ${machine.machineId} totalTaps from ${machine.totalTaps} to ${totalTaps}`);
      await Machine.updateOne(
        { _id: machine._id },
        { $set: { totalTaps: totalTaps } }
      );
    }
    
    const responseData = {
      success: true,
      machine: {
        _id: machine._id,
        machineId: machine.machineId,
        location: machine.location,
        state: machine.state,
        country: machine.country,
        totalTaps: totalTaps,
        machineCost: machine.machineCost || 0,
        status: machine.status,
        costPerTap: costPerTap,
        rentPerMonth: rentPerMonth,
        maintenanceCostPerMonth: maintenanceCost,
        monthlyTaps: monthlyTaps,
        monthlyRevenue: monthlyRevenue,
        netProfit: netProfit,
        assignedTo: machine.assignedTo,
        operatorId: machine.operatorId,
        createdAt: machine.createdAt,
        updatedAt: machine.updatedAt
      },
      recentLogs: recentLogs.map(log => ({
        date: log.date,
        tapCount: log.tapCount || 0,
        time: log.timestamp
      }))
    };
    
    console.log(`✅ Returning machine details: Total Taps: ${totalTaps}, Monthly Taps: ${monthlyTaps}, Net Profit: ${netProfit}`);
    res.json(responseData);
    
  } catch (err: any) {
    console.error("❌ Error fetching machine details:", err);
    res.status(500).json({ 
      success: false, 
      error: err.message 
    });
  }
});

// ======================================================
// GET CUSTOMER'S MACHINES FOR OPERATOR ASSIGNMENT
// ======================================================
router.get("/customer-machines", auth, allowRoles("customer"), async (req: any, res: Response) => {
  console.log("\n🟢 [GET /customer/customer-machines] Request received");
  console.log("📌 Customer ID:", req.user.id);
  
  try {
    const customerId = req.user.id;
    
    const machines = await Machine.find({ 
      assignedTo: customerId 
    }).select('_id machineId location status operatorId machineCost totalTaps');
    
    console.log(`📊 Found ${machines.length} machines`);
    machines.forEach(m => {
      console.log(`   - ${m.machineId}: ${m.location} (Cost: ${m.machineCost}, Operator: ${m.operatorId ? 'Assigned' : 'Unassigned'})`);
    });
    
    res.json({
      success: true,
      machines: machines.map((m: any) => ({
        _id: m._id,
        machineId: m.machineId,
        location: m.location,
        status: m.status,
        machineCost: m.machineCost || 0,
        totalTaps: m.totalTaps || 0,
        hasOperator: !!m.operatorId
      }))
    });
    
  } catch (err: any) {
    console.error("❌ Error fetching customer machines:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ======================================================
// OPERATOR MANAGEMENT
// ======================================================

// Create operator
router.post("/operator/create", auth, allowRoles("customer"), async (req: any, res: Response) => {
  console.log("\n" + "=".repeat(60));
  console.log("🔵 [POST /customer/operator/create] Request received");
  console.log("=".repeat(60));
  console.log("📌 Request body:", JSON.stringify(req.body, null, 2));
  console.log("📌 User ID from token:", req.user.id);
  console.log("📌 User Role from token:", req.user.role);
  
  try {
    const customerId = req.user.id;
    const { name, phoneNumber, email, assignedMachineIds = [] } = req.body;

    // STEP 1: Validate required fields
    console.log("\n📝 STEP 1: Validating required fields...");
    const missingFields = [];
    if (!name) missingFields.push('name');
    if (!phoneNumber) missingFields.push('phoneNumber');
    if (!email) missingFields.push('email');
    
    if (missingFields.length > 0) {
      console.log("❌ Missing fields:", missingFields);
      return res.status(400).json({ 
        success: false,
        message: `Missing required fields: ${missingFields.join(', ')}`,
        missingFields
      });
    }
    console.log("✅ All required fields present");

    // STEP 2: Validate phone number format
    console.log("\n📞 STEP 2: Validating phone number format...");
    if (!/^[0-9]{10}$/.test(phoneNumber)) {
      console.log("❌ Invalid phone number format:", phoneNumber);
      return res.status(400).json({ 
        success: false, 
        message: "Invalid phone number. Must be exactly 10 digits" 
      });
    }
    console.log("✅ Phone number format valid");

    // STEP 3: Validate email format
    console.log("\n📧 STEP 3: Validating email format...");
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      console.log("❌ Invalid email format:", email);
      return res.status(400).json({ 
        success: false, 
        message: "Invalid email format" 
      });
    }
    console.log("✅ Email format valid");

    // STEP 4: Check if user already exists
    console.log("\n🔍 STEP 4: Checking for existing user...");
    const existingUser = await User.findOne({ $or: [{ email: email.toLowerCase() }, { phoneNumber }] });
    if (existingUser) {
      const duplicateField = existingUser.email === email.toLowerCase() ? 'email' : 'phone number';
      console.log(`❌ User already exists with this ${duplicateField}`);
      return res.status(400).json({ 
        success: false, 
        message: `User already exists with this ${duplicateField}` 
      });
    }
    console.log("✅ No existing user found");

    // STEP 5: Get customer parent
    console.log("\n👤 STEP 5: Fetching parent customer...");
    const parentUser = await User.findById(customerId);
    if (!parentUser) {
      console.log("❌ Parent customer not found for ID:", customerId);
      return res.status(404).json({ 
        success: false, 
        message: "Customer not found" 
      });
    }
    console.log("✅ Parent customer found:", parentUser.name);

    // STEP 6: Validate machines
    console.log("\n🖥️ STEP 6: Validating machines...");
    let validatedMachines: any[] = [];
    if (assignedMachineIds.length > 0) {
      validatedMachines = await Machine.find({
        _id: { $in: assignedMachineIds },
        assignedTo: customerId,
        operatorId: null
      });

      console.log(`✅ Found ${validatedMachines.length} valid machines out of ${assignedMachineIds.length}`);
      
      const validIds = validatedMachines.map((m: any) => m._id.toString());
      const invalidIds = assignedMachineIds.filter((id: any) => !validIds.includes(id));
      
      if (invalidIds.length > 0) {
        console.log("❌ Invalid machine IDs:", invalidIds);
        return res.status(400).json({
          success: false,
          message: "Some machines are invalid, not owned by you, or already have an operator",
          invalidMachineIds: invalidIds
        });
      }
      
      validatedMachines.forEach(machine => {
        console.log(`   - ${machine.machineId} (Location: ${machine.location})`);
      });
    } else {
      console.log("⚠️ No machines assigned to operator");
    }

    // STEP 7: Create operator
    console.log("\n👷 STEP 7: Creating operator user...");
    const operator = await User.create({
      name: name.trim(),
      phoneNumber,
      email: email.toLowerCase().trim(),
      location: parentUser.location || '',
      state: parentUser.state,
      country: parentUser.country,
      role: "operator",
      parent: customerId,
      assignedMachines: validatedMachines.map((m: any) => m._id),
      isFirstLogin: true
    });
    
    console.log("✅ Operator created with ID:", operator._id);

    // STEP 8: Assign operator to machines
    if (validatedMachines.length > 0) {
      console.log("\n🔗 STEP 8: Assigning operator to machines...");
      await Machine.updateMany(
        { _id: { $in: validatedMachines.map((m: any) => m._id) } },
        { $set: { operatorId: operator._id } }
      );
      console.log(`✅ Updated ${validatedMachines.length} machines with operator ID`);
    }

    // STEP 9: Prepare response
    const operatorResponse = operator.toObject();
    delete operatorResponse.password;
    delete operatorResponse.refreshToken;

    console.log("\n✅ OPERATOR CREATED SUCCESSFULLY!");
    console.log("=".repeat(60) + "\n");

    res.status(201).json({ 
      success: true,
      message: "Operator created successfully", 
      user: operatorResponse,
      assignedMachines: validatedMachines.map((m: any) => ({ 
        _id: m._id, 
        machineId: m.machineId, 
        location: m.location 
      }))
    });

  } catch (err: any) {
    console.error("\n❌ ERROR CREATING OPERATOR:");
    console.error("   Error message:", err.message);
    console.log("=".repeat(60) + "\n");
    
    if (err.code === 11000) {
      const field = Object.keys(err.keyPattern)[0];
      return res.status(400).json({ 
        success: false, 
        message: `Duplicate value for ${field}. Please use a different ${field}.` 
      });
    }
    
    res.status(500).json({ 
      success: false, 
      error: err.message
    });
  }
});

// Get all operators
router.get("/operators", auth, allowRoles("customer"), async (req: any, res: Response) => {
  console.log("\n🟢 [GET /customer/operators] Request received");
  console.log("📌 User ID:", req.user.id);
  
  try {
    const customerId = req.user.id;
    
    const operators = await User.find({
      parent: customerId,
      role: "operator"
    }).select("-password -refreshToken").populate('assignedMachines', 'machineId location status totalTaps machineCost');
    
    console.log(`📊 Found ${operators.length} operators`);
    
    const operatorsWithStats = await Promise.all(operators.map(async (operator) => {
      const machines = operator.assignedMachines || [];
      let totalTapsToday = 0;
      let totalTapsMonth = 0;
      const today = new Date().toISOString().split('T')[0];
      const currentDate = new Date();
      const currentYear = currentDate.getFullYear();
      const currentMonth = String(currentDate.getMonth() + 1).padStart(2, '0');
      const currentMonthStr = `${currentYear}-${currentMonth}`;
      
      for (const machine of machines) {
        // Get today's taps
        const todayLogs = await Log.find({ 
          machineId: machine.machineId, 
          date: today,
          action: "TAP_DISPENSED"
        });
        totalTapsToday += todayLogs.reduce((sum: any, log: any) => sum + (log.tapCount || 0), 0);
        
        // Get this month's taps
        const monthLogs = await Log.find({
          machineId: machine.machineId,
          date: { $regex: `^${currentMonthStr}` },
          action: "TAP_DISPENSED"
        });
        totalTapsMonth += monthLogs.reduce((sum: any, log: any) => sum + (log.tapCount || 0), 0);
      }
      
      return {
        _id: operator._id,
        name: operator.name,
        email: operator.email,
        phoneNumber: operator.phoneNumber,
        location: operator.location,
        assignedMachines: machines,
        totalMachines: machines.length,
        totalTapsToday,
        totalTapsMonth,
        createdAt: operator.createdAt
      };
    }));
    
    res.json({
      success: true,
      operators: operatorsWithStats
    });
    
  } catch (err: any) {
    console.error("❌ Error fetching operators:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// Delete operator
router.delete("/operator/:operatorId", auth, allowRoles("customer"), async (req: any, res: Response) => {
  console.log("\n🟢 [DELETE /customer/operator/:operatorId] Request received");
  console.log("📌 Operator ID:", req.params.operatorId);
  console.log("📌 Customer ID:", req.user.id);
  
  try {
    const customerId = req.user.id;
    const { operatorId } = req.params;
    
    const operator = await User.findOne({
      _id: operatorId,
      parent: customerId,
      role: "operator"
    });
    
    if (!operator) {
      console.log("❌ Operator not found");
      return res.status(404).json({ success: false, message: "Operator not found" });
    }
    
    console.log(`✅ Found operator: ${operator.name}`);
    
    await Machine.updateMany(
      { operatorId: operatorId },
      { $set: { operatorId: null } }
    );
    console.log(`📊 Removed operator from machines`);
    
    await operator.deleteOne();
    console.log(`✅ Operator ${operator.name} deleted successfully`);
    
    res.json({
      success: true,
      message: "Operator deleted successfully"
    });
    
  } catch (err: any) {
    console.error("❌ Error deleting operator:", err);
    res.status(500).json({ success: false, error: err.message });
  }
});

// ======================================================
router.get("/daily-logs", auth, allowRoles("customer"), async (req: any, res: Response) => {
  console.log("\n🟢 [GET /customer/daily-logs] Request received");
  
  try {
    const customerId = req.user.id;
    
    const machines = await Machine.find({ assignedTo: customerId }).lean();
    const machineIds = machines.map((m: any) => m.machineId);
    
    if (!machineIds.length) {
      return res.json([]);
    }
    
    // Get all TAP_DISPENSED logs for customer's machines
    const logs = await Log.find({
      machineId: { $in: machineIds },
      action: "TAP_DISPENSED"
    })
    .sort({ date: 1 })
    .lean();
    
    // Format logs for graph
    const formattedLogs = logs.map(log => ({
      date: log.date,
      machineId: log.machineId,
      tapCount: log.tapCount || 0,
      timestamp: log.timestamp
    }));
    
    console.log(`✅ Returning ${formattedLogs.length} daily log entries`);
    res.json(formattedLogs);
    
  } catch (err: any) {
    console.error("❌ Error fetching daily logs:", err);
    res.status(500).json({ error: err.message });
  }
});

// Add to your customerRoute.js
router.get("/all-logs", auth, allowRoles("customer"), async (req: any, res: Response) => {
  try {
    const customerId = req.user.id;
    
    // Get all machines assigned to this customer
    const machines = await Machine.find({ assignedTo: customerId });
    const machineIds = machines.map((m: any) => m.machineId);
    
    // Get all logs for these machines
    const logs = await Log.find({ 
      machineId: { $in: machineIds } 
    }).sort({ date: -1 });
    
    res.json(logs);
  } catch (err: any) {
    console.error("Error fetching logs:", err);
    res.status(500).json({ error: err.message });
  }
});


router.post("/report/create", auth, allowRoles("customer"), async (req: any, res: Response) => {
  console.log("\n" + "=".repeat(60));
  console.log("🔵 [POST /customer/report/create] Request received");
  console.log("=".repeat(60));
  console.log("📌 Customer ID:", req.user.id);
  console.log("📌 Request body:", JSON.stringify(req.body, null, 2));
  
  try {
    const customerId = req.user.id;
    const { subject, description } = req.body;

    // STEP 1: Validate required fields
    console.log("\n📝 STEP 1: Validating required fields...");
    const missingFields = [];
    if (!subject) missingFields.push('subject');
    if (!description) missingFields.push('description');
    
    if (missingFields.length > 0) {
      console.log("❌ Missing fields:", missingFields);
      return res.status(400).json({ 
        success: false,
        message: `Missing required fields: ${missingFields.join(', ')}`,
        missingFields
      });
    }
    console.log("✅ All required fields present");

    console.log("\n📏 STEP 2: Validating field lengths...");
    if (subject.length > 200) {
      console.log("❌ Subject too long:", subject.length);
      return res.status(400).json({ 
        success: false, 
        message: "Subject cannot exceed 200 characters" 
      });
    }
    if (description.length > 1000) {
      console.log("❌ Description too long:", description.length);
      return res.status(400).json({ 
        success: false, 
        message: "Description cannot exceed 1000 characters" 
      });
    }
    console.log("✅ Field lengths valid");

    console.log("\n👤 STEP 3: Fetching customer details...");
    const customer = await User.findById(customerId).select('name email phoneNumber');
    if (!customer) {
      console.log("❌ Customer not found for ID:", customerId);
      return res.status(404).json({ 
        success: false, 
        message: "Customer not found" 
      });
    }
    console.log("✅ Customer found:", customer.name);

    console.log("\n📄 STEP 4: Creating report...");
    
    // Generate unique report ID
    const reportId = `RPT-${Date.now()}-${Math.random().toString(36).substring(2, 8).toUpperCase()}`;
    
    const report = new Report({
      reportId: reportId,
      customer: {
        id: customerId,
        email: customer.email,
        name: customer.name,
        phone: customer.phoneNumber || 'N/A'
      },
      subject: subject.trim(),
      description: description.trim(),
      status: 'pending'
    });

    await report.save();
    console.log("✅ Report created with ID:", reportId);

    const responseData = {
      success: true,
      message: "Report submitted successfully",
      report: {
        reportId: report.reportId,
        subject: report.subject,
        description: report.description,
        status: report.status,
        createdAt: report.createdAt,
        customer: {
          name: report.customer.name,
          email: report.customer.email
        }
      }
    };

    console.log("\n✅ REPORT CREATED SUCCESSFULLY!");
    console.log("=".repeat(60) + "\n");

    res.status(201).json(responseData);

  } catch (err: any) {
    console.error("\n❌ ERROR CREATING REPORT:");
    console.error("   Error message:", err.message);
    console.error("   Stack:", err.stack);
    console.log("=".repeat(60) + "\n");
    
    res.status(500).json({ 
      success: false, 
      error: "INTERNAL_SERVER_ERROR",
      message: err.message
    });
  }
});


router.get("/reports", auth, allowRoles("customer"), async (req: any, res: Response) => {
  console.log("\n" + "=".repeat(60));
  console.log("🔵 [GET /customer/reports] Request received");
  console.log("=".repeat(60));
  console.log("📌 Customer ID:", req.user.id);
  console.log("📌 Query Params:", req.query);
  
  try {
    const customerId = req.user.id;
    const { status } = req.query; 

    console.log("\n📄 STEP 1: Fetching reports...");
    
    const filter = { 'customer.id': customerId };
    if (status && status !== 'all') {
      filter.status = status;
      console.log(`📌 Filtering by status: ${status}`);
    }

    const reports = await Report.find(filter)
      .sort({ createdAt: -1 }) // Latest first
      .select('reportId subject description status createdAt updatedAt resolvedAt resolutionNotes');

    console.log(`📊 Found ${reports.length} reports for customer`);

    const totalReports = reports.length;
    const pendingReports = reports.filter(r => r.status === 'pending').length;
    const solvedReports = reports.filter(r => r.status === 'solved').length;

    console.log(`📊 Stats: Total=${totalReports}, Pending=${pendingReports}, Solved=${solvedReports}`);

    const formattedReports = reports.map(report => ({
      reportId: report.reportId,
      subject: report.subject,
      description: report.description,
      status: report.status,
      createdAt: report.createdAt,
      updatedAt: report.updatedAt,
      resolvedAt: report.resolvedAt || null,
      resolutionNotes: report.resolutionNotes || null
    }));

    const responseData = {
      success: true,
      count: totalReports,
      statistics: {
        total: totalReports,
        pending: pendingReports,
        solved: solvedReports
      },
      reports: formattedReports
    };

    console.log("\n✅ REPORTS FETCHED SUCCESSFULLY!");
    console.log("=".repeat(60) + "\n");

    res.json(responseData);

  } catch (err: any) {
    console.error("\n❌ ERROR FETCHING REPORTS:");
    console.error("   Error message:", err.message);
    console.error("   Stack:", err.stack);
    console.log("=".repeat(60) + "\n");
    
    res.status(500).json({ 
      success: false, 
      error: "INTERNAL_SERVER_ERROR",
      message: err.message
    });
  }
});

router.get("/report/:reportId", auth, allowRoles("customer"), async (req: any, res: Response) => {
  console.log("\n" + "=".repeat(60));
  console.log("🔵 [GET /customer/report/:reportId] Request received");
  console.log("=".repeat(60));
  console.log("📌 Report ID:", req.params.reportId);
  console.log("📌 Customer ID:", req.user.id);
  
  try {
    const customerId = req.user.id;
    const { reportId } = req.params;

    console.log("\n📄 STEP 1: Fetching report...");
    
    const report = await Report.findOne({ 
      reportId: reportId,
      'customer.id': customerId
    });

    if (!report) {
      console.log("❌ Report not found or not owned by customer");
      return res.status(404).json({ 
        success: false, 
        message: "Report not found" 
      });
    }

    console.log("✅ Report found:", report.subject);

    const responseData = {
      success: true,
      report: {
        reportId: report.reportId,
        subject: report.subject,
        description: report.description,
        status: report.status,
        customer: {
          name: report.customer.name,
          email: report.customer.email
        },
        createdAt: report.createdAt,
        updatedAt: report.updatedAt,
        resolvedAt: report.resolvedAt || null,
        resolutionNotes: report.resolutionNotes || null
      }
    };

    console.log("\n✅ REPORT DETAILS FETCHED SUCCESSFULLY!");
    console.log("=".repeat(60) + "\n");

    res.json(responseData);

  } catch (err: any) {
    console.error("\n❌ ERROR FETCHING REPORT DETAILS:");
    console.error("   Error message:", err.message);
    console.log("=".repeat(60) + "\n");
    
    res.status(500).json({ 
      success: false, 
      error: "INTERNAL_SERVER_ERROR",
      message: err.message
    });
  }
});

export default router;
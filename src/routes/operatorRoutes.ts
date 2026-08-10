// @ts-nocheck
import { Router, Response } from 'express';
import Machine from '../Model/machineSchema';
import User from '../Model/userSchema';
import Log from '../Model/logSchema';
import { auth, allowRoles } from '../middleware/auth';
// routes/operatorRoutes.js - UPDATED WITH VALID ENUM VALUES
const router = Router();

// Debug flag - set to false in production
const DEBUG = true;

function debugLog(level, message, data = null) {
  if (!DEBUG) return;
  
  const timestamp = new Date().toISOString();
  const prefix = `[${timestamp}] [OPERATOR]`;
  
  switch(level) {
    case 'ERROR':
      console.error(`${prefix} ❌ ${message}`);
      break;
    case 'WARN':
      console.warn(`${prefix} ⚠️ ${message}`);
      break;
    case 'SUCCESS':
      console.log(`${prefix} ✅ ${message}`);
      break;
    default:
      console.log(`${prefix} 📌 ${message}`);
  }
  
  if (data) {
    console.log(`${prefix} 📦:`, typeof data === 'object' ? JSON.stringify(data, null, 2) : data);
  }
}

// Active sessions tracking (for frontend status only)
const activeSessions = new Map();

// ======================================================
// GET OPERATOR'S ASSIGNED MACHINES
// ======================================================
router.get("/machines", auth, allowRoles("operator"), async (req: any, res: Response) => {
  const requestId = Math.random().toString(36).substring(7);
  debugLog('INFO', `[${requestId}] GET /machines`);
  
  try {
    const operatorId = req.user.id;
    debugLog('INFO', `[${requestId}] Operator: ${operatorId}`);
    
    const machines = await Machine.find({ 
      operatorId: operatorId 
    }).select('machineId location status costPerTap totalTaps lastActive');
    
    debugLog('INFO', `[${requestId}] Found ${machines.length} machines`);
    
    const today = new Date().toISOString().split('T')[0];
    
    const machinesWithStats = await Promise.all(machines.map(async (machine) => {
      const todaysLogs = await Log.find({
        machineId: machine.machineId,
        date: today
      });
      
      const todaysCycles = todaysLogs.reduce((sum: any, log: any) => sum + (log.tapCount || 0), 0);
      const session = activeSessions.get(machine._id.toString());
      
      return {
        _id: machine._id,
        machineId: machine.machineId,
        location: machine.location || 'Unknown',
        status: session ? 'cleaning' : (machine.status || 'idle'),
        costPerCycle: machine.costPerTap || 0.50,
        todaysCycles: todaysCycles,
        currentSessionCycles: session?.taps || 0,
        totalCycles: machine.totalTaps || 0,
        lastActive: machine.lastActive || machine.updatedAt
      };
    }));
    
    debugLog('SUCCESS', `[${requestId}] Returning ${machinesWithStats.length} machines`);
    res.json(machinesWithStats);
    
  } catch (err: any) {
    debugLog('ERROR', `[${requestId}] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ======================================================
// START CLEANING - SENDS "START" COMMAND TO ESP32
// ======================================================
// ======================================================
// START CLEANING - SENDS "START" COMMAND TO ESP32
// ======================================================
router.post("/machine/start", auth, allowRoles("operator"), async (req: any, res: Response) => {
  const requestId = Math.random().toString(36).substring(7);
  debugLog('INFO', `[${requestId}] POST /machine/start`);
  
  try {
    const { machineId } = req.body;
    const operatorId = req.user.id;
    
    if (!machineId) {
      return res.status(400).json({ 
        success: false, 
        message: "Machine ID is required" 
      });
    }
    
    debugLog('INFO', `[${requestId}] Machine: ${machineId}, Operator: ${operatorId}`);

    const mqttClient = req.app.get('mqttClient');
    
    if (!mqttClient || !mqttClient.connected) {
      debugLog('ERROR', `[${requestId}] MQTT not available`);
      return res.status(503).json({ 
        success: false, 
        message: 'MQTT service not available' 
      });
    }

    const machine = await Machine.findOne({
      _id: machineId,
      operatorId: operatorId
    });

    if (!machine) {
      return res.status(404).json({ 
        success: false,
        message: "Machine not found or not assigned" 
      });
    }

    if (activeSessions.has(machineId)) {
      return res.status(400).json({ 
        success: false,
        message: "Machine is already cleaning" 
      });
    }

    const topic = `freshpod_vending_2025/${machine.machineId}`;
    const message = JSON.stringify({
      action: "START",
      amount: machine.costPerTap || 0.50,
      userId: operatorId,
      timestamp: Date.now()
    });

    debugLog('INFO', `[${requestId}] Publishing to ${topic}`);

    mqttClient.publish(topic, message, { qos: 1 }, async (err) => {
      if (err) {
        debugLog('ERROR', `[${requestId}] MQTT error: ${err.message}`);
        return res.status(500).json({
          success: false,
          message: 'Failed to send command to machine'
        });
      }
      
      debugLog('SUCCESS', `[${requestId}] START sent to ${machine.machineId}`);
      
      // Create session for tracking
      const session = {
        machineId,
        operatorId,
        startTime: new Date(),
        taps: 1, // Start with 1 tap
        machineCode: machine.machineId,
        sessionId: requestId
      };
      
      activeSessions.set(machineId, session);
      debugLog('INFO', `[${requestId}] Session created. Active sessions: ${activeSessions.size}`);
      
      const today = new Date().toISOString().split('T')[0];
      
      // ==============================================
      // 1. UPDATE MACHINE TOTAL TAPS
      // ==============================================
      const updatedMachine = await Machine.findOneAndUpdate(
        { _id: machineId },
        { 
          $inc: { totalTaps: 1 },  // Increase by 1
          lastActive: new Date()
        },
        { new: true }  // Return updated document
      );
      
      debugLog('SUCCESS', `[${requestId}] Machine total taps updated to: ${updatedMachine.totalTaps}`);
      
      // ==============================================
      // 2. CREATE TAP LOG (tapCount: 1)
      // ==============================================
      try {
        const tapLog = await Log.create({
          machineId: machine.machineId,
          date: today,
          action: 'TAP_DISPENSED',     // Changed from START to TAP_DISPENSED
          status: 'completed',          // Changed from sent to completed
          tapCount: 1,                  // ✅ Set to 1 instead of 0
          initiatedBy: operatorId,
          amount: machine.costPerTap || 0.50,
          sessionId: requestId,
          sessionTaps: 1,
          timestamp: new Date(),
          metadata: { 
            type: 'tap_record',
            tap_number: 1,
            topic: topic,
            mqtt_message: message
          }
        });
        debugLog('SUCCESS', `[${requestId}] ✅ TAP LOG created - TapCount: ${tapLog.tapCount}`);
      } catch (tapLogErr: any) {
        debugLog('ERROR', `[${requestId}] Failed to create tap log: ${tapLogErr.message}`);
      }
      
      // ==============================================
      // 3. CREATE START LOG (for tracking)
      // ==============================================
      try {
        await Log.create({
          machineId: machine.machineId,
          date: today,
          action: 'START',
          status: 'sent',
          tapCount: 0,  // START log has 0 taps
          initiatedBy: operatorId,
          amount: machine.costPerTap || 0.50,
          sessionId: requestId,
          timestamp: new Date(),
          metadata: { 
            command_sent: true,
            topic: topic,
            mqtt_message: message
          }
        });
        debugLog('SUCCESS', `[${requestId}] START log entry created`);
      } catch (logErr: any) {
        debugLog('ERROR', `[${requestId}] Failed to create start log: ${logErr.message}`);
      }

      res.json({
        success: true,
        message: "Cleaning started and tap recorded successfully",
        session: {
          startTime: session.startTime,
          machineId: machine.machineId,
          sessionId: requestId,
          tapCount: session.taps
        },
        machine: {
          totalTaps: updatedMachine.totalTaps
        }
      });
    });

  } catch (err: any) {
    debugLog('ERROR', `[${requestId}] ${err.message}`);
    debugLog('ERROR', `[${requestId}] Stack: ${err.stack}`);
    res.status(500).json({ error: err.message });
  }
});

// ======================================================
// GET MACHINE STATUS (Real-time from MQTT cache)
// ======================================================
router.get("/machine/:id/status", auth, allowRoles("operator"), async (req: any, res: Response) => {
  const requestId = Math.random().toString(36).substring(7);
  
  try {
    const machineId = req.params.id;
    const operatorId = req.user.id;
    
    // Verify machine belongs to operator
    const machine = await Machine.findOne({
      _id: machineId,
      operatorId: operatorId
    });
    
    if (!machine) {
      return res.status(404).json({ error: "Machine not found" });
    }
    
    const cache = req.app.get('machineStatusCache');
    const cachedStatus = cache?.get(machine.machineId) || {};
    const session = activeSessions.get(machineId);
    
    res.json({
      machineId: machine.machineId,
      status: session ? 'cleaning' : (cachedStatus.status || machine.status || 'idle'),
      lastSeen: cachedStatus.lastUpdate || machine.lastActive,
      currentSessionCycles: session?.taps || 0,
      message: cachedStatus.message || ''
    });
    
  } catch (err: any) {
    debugLog('ERROR', `[${requestId}] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ======================================================
// GET MACHINE HISTORY
// ======================================================
router.get("/machine/:id/history", auth, allowRoles("operator"), async (req: any, res: Response) => {
  const requestId = Math.random().toString(36).substring(7);
  
  try {
    const machineId = req.params.id;
    const operatorId = req.user.id;
    
    const machine = await Machine.findOne({
      _id: machineId,
      operatorId: operatorId
    });
    
    if (!machine) {
      return res.status(404).json({ 
        success: false,
        message: "Machine not found" 
      });
    }
    
    const logs = await Log.find({ machineId: machine.machineId })
      .sort({ date: -1, timestamp: -1 })
      .limit(50);
    
    const formattedLogs = logs.map(log => ({
      date: log.date,
      time: log.timestamp,
      cycles: log.tapCount || 0,
      revenue: (log.tapCount || 0) * (machine.costPerTap || 0.50),
      status: log.status,
      action: log.action,
      sessionId: log.sessionId
    }));
    
    res.json(formattedLogs);
    
  } catch (err: any) {
    debugLog('ERROR', `[${requestId}] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ======================================================
// GET OPERATOR DASHBOARD STATS
// ======================================================
router.get("/dashboard", auth, allowRoles("operator"), async (req: any, res: Response) => {
  const requestId = Math.random().toString(36).substring(7);
  
  try {
    const operatorId = req.user.id;
    
    const machines = await Machine.find({ operatorId: operatorId });
    const today = new Date().toISOString().split('T')[0];
    
    let totalCyclesToday = 0;
    let totalRevenueToday = 0;
    let activeMachines = 0;
    
    for (const machine of machines) {
      const todaysLog = await Log.findOne({
        machineId: machine.machineId,
        date: today,
        action: { $in: ['CLEANING_COMPLETED', 'TAP_DISPENSED', 'DISINFECTION_COMPLETED', 'CYCLE_COMPLETED'] }
      });
      
      const cycles = todaysLog?.tapCount || 0;
      totalCyclesToday += cycles;
      totalRevenueToday += cycles * (machine.costPerTap || 0.50);
      
      if (activeSessions.has(machine._id.toString())) {
        activeMachines++;
      }
    }
    
    res.json({
      totalMachines: machines.length,
      activeMachines,
      totalCyclesToday,
      totalRevenueToday,
      avgCyclesPerMachine: machines.length > 0 ? Math.round(totalCyclesToday / machines.length) : 0
    });
    
  } catch (err: any) {
    debugLog('ERROR', `[${requestId}] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// Add this after your other routes (around line 200)

// ======================================================
// GET OPERATOR'S COMPLETE HISTORY (All Machines)
// ======================================================
router.get("/history", auth, allowRoles("operator"), async (req: any, res: Response) => {
  const requestId = Math.random().toString(36).substring(7);
  debugLog('INFO', `[${requestId}] GET /history`);
  
  try {
    const operatorId = req.user.id;
    
    // Get all machines assigned to this operator
    const machines = await Machine.find({ 
      operatorId: operatorId 
    }).select('machineId costPerTap');
    
    if (machines.length === 0) {
      return res.json([]);
    }
    
    const machineIds = machines.map((m: any) => m.machineId);
    
    // Get all logs for these machines
    const logs = await Log.find({ 
      machineId: { $in: machineIds }
    }).sort({ date: -1, timestamp: -1 }).limit(100);
    
    // Map machine costs
    const machineCostMap = new Map();
    machines.forEach(m => {
      machineCostMap.set(m.machineId, m.costPerTap || 0.50);
    });
    
    const history = logs.map(log => ({
      date: log.date,
      machineId: log.machineId,
      tapCount: log.tapCount || 0,
      costPerTap: machineCostMap.get(log.machineId) || 0.50,
      action: log.action,
      status: log.status,
      timestamp: log.timestamp
    }));
    
    debugLog('SUCCESS', `[${requestId}] Returning ${history.length} records`);
    res.json(history);
    
  } catch (err: any) {
    debugLog('ERROR', `[${requestId}] ${err.message}`);
    res.status(500).json({ error: err.message });
  }
});

// ======================================================
// CLEANUP: Remove inactive sessions (run every minute)
// ======================================================
setInterval(() => {
  const now = Date.now();
  let removedCount = 0;
  
  for (const [id, session] of activeSessions.entries()) {
    const sessionAge = (now - new Date(session.startTime).getTime()) / 1000 / 60; // minutes
    
    // Remove sessions older than 10 minutes (cleaning takes ~4-5 min)
    if (sessionAge > 5) {
      activeSessions.delete(id);
      removedCount++;
      debugLog('INFO', `Cleaned up stale session for machine ${id} (${sessionAge.toFixed(1)} min old)`);
    }
  }
  
  if (removedCount > 0) {
    debugLog('INFO', `Removed ${removedCount} stale sessions`);
  }
}, 60000); // Run every minute

export default router;
import { Request, Response } from 'express';
import { MachineService } from './machine.service';
import { Machine, Log, SanitizationRefill, CustomerMachineSettings } from './machine.model';
import User from '../user/user.model';
import Payment from '../payment/payment.model';
import mqttService from '../../services/mqttService';
import mongoose from 'mongoose';

export class MachineController {

  /**
   * Search machines matching query string.
   */
  static async searchMachines(req: any, res: Response) {
    try {
      const { q } = req.query;
      const machines = await MachineService.searchMachines(String(q || ""), req.user.id, req.user.role);
      res.json({
        success: true,
        count: machines.length,
        machines
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: "Error searching machines", error: err.message });
    }
  }

  /**
   * Get telemetry data and logs details of a specific machine.
   */
  static async getMachineDetails(req: any, res: Response) {
    try {
      const { machineId } = req.params;
      const data = await MachineService.getMachineDetails(machineId, req.user.id, req.user.role);
      if (!data) {
        return res.status(404).json({ success: false, message: "Machine not found or you don't have access" });
      }
      res.json({
        success: true,
        machine: data.machine,
        recentLogs: data.recentLogs,
        sanitizationLevel: data.sanitizationLevel
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: "Error fetching machine details", error: err.message });
    }
  }

  /**
   * Fetch all machines (or filtered by user role) with revenue rollups.
   */
  static async getMachinesData(req: any, res: Response) {
    try {
      const role = req.user.role;
      const id = req.user.id;

      let machines: any[] = [];
      if (role === 'admin') {
        machines = await Machine.find({ isDeleted: { $ne: true } })
          .populate('dealership', 'name email')
          .populate('assignedTo', 'name email')
          .populate('operatorId', 'name email');
      } else if (role === 'dealership') {
        machines = await Machine.find({ dealership: id, isDeleted: { $ne: true } })
          .populate('assignedTo', 'name email');
      } else if (role === 'customer') {
        machines = await Machine.find({ assignedTo: id, isDeleted: { $ne: true } });
      }

      // Compute monthly revenues
      const thirtyDaysAgo = new Date();
      thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

      const payments = await Payment.find({
        status: 'paid',
        timestamp: { $gte: thirtyDaysAgo }
      });

      const monthlyRevenueMap: Record<string, number> = {};
      payments.forEach((payment: any) => {
        if (!monthlyRevenueMap[payment.machineId]) {
          monthlyRevenueMap[payment.machineId] = 0;
        }
        monthlyRevenueMap[payment.machineId] += payment.amount;
      });

      const formatted = machines.map((machine: any) => ({
        _id: machine._id.toString(),
        machineId: machine.machineId,
        qrId: machine.qrId || "",
        location: machine.location,
        costPerTap: machine.costPerTap,
        totalTaps: machine.totalTaps,
        status: machine.status,
        dealership: machine.dealership ? {
          id: machine.dealership._id.toString(),
          name: machine.dealership.name,
          email: machine.dealership.email
        } : null,
        assignedTo: machine.assignedTo ? {
          id: machine.assignedTo._id.toString(),
          name: machine.assignedTo.name,
          email: machine.assignedTo.email
        } : null,
        operatorId: machine.operatorId ? {
          id: machine.operatorId._id.toString(),
          name: machine.operatorId.name,
          email: machine.operatorId.email
        } : null,
        monthlyRevenue: monthlyRevenueMap[machine.machineId] || 0,
        createdAt: machine.createdAt,
        updatedAt: machine.updatedAt
      }));

      res.json(formatted);
    } catch (err: any) {
      console.error("Error in /machine/data:", err);
      res.status(500).json({ error: err.message });
    }
  }

  /**
   * Create a new machine configuration.
   */
  static async createMachine(req: any, res: Response) {
    try {
      const { machineId, location, costPerTap, qrId } = req.body;
      if (!machineId || !location || costPerTap === undefined) {
        return res.status(400).json({ error: "Missing required parameters" });
      }

      // Check duplicate
      const existing = await Machine.findOne({ machineId });
      if (existing) return res.status(400).json({ error: "Machine ID already registered" });

      if (qrId) {
        const existingQr = await Machine.findOne({ qrId });
        if (existingQr) return res.status(400).json({ error: "QR ID Reference already registered" });
      }

      const machine = await Machine.create({
        machineId,
        location,
        costPerTap,
        qrId: qrId || undefined,
        totalTaps: 0,
        status: "active"
      });

      res.status(201).json({ success: true, message: "Machine registered successfully", machine });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /**
   * Update machine parameters.
   */
  static async updateMachine(req: any, res: Response) {
    try {
      const { id } = req.params;
      const { location, costPerTap, status, qrId } = req.body;

      const machine = await Machine.findById(id);
      if (!machine) return res.status(404).json({ error: "Machine not found" });

      if (qrId && qrId !== machine.qrId) {
        const existingQr = await Machine.findOne({ qrId, _id: { $ne: id } });
        if (existingQr) return res.status(400).json({ error: "QR ID Reference already registered" });
      }

      if (location !== undefined) machine.location = location;
      if (costPerTap !== undefined) machine.costPerTap = costPerTap;
      if (status !== undefined) machine.status = status;
      if (qrId !== undefined) machine.qrId = qrId || undefined;

      await machine.save();

      res.json({ success: true, message: "Machine configuration updated successfully", machine });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /**
   * Soft delete a machine using session transactions.
   */
  static async deleteMachine(req: any, res: Response) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const { id } = req.params;
      const machine = await Machine.findById(id).session(session);
      if (!machine) {
        await session.abortTransaction();
        session.endSession();
        return res.status(404).json({ message: "Machine not found" });
      }

      // Release user allocations
      if (machine.dealership) {
        await User.updateOne({ _id: machine.dealership }, { $pull: { assignedMachines: machine._id } }, { session });
      }
      if (machine.assignedTo) {
        await User.updateOne({ _id: machine.assignedTo }, { $pull: { assignedMachines: machine._id } }, { session });
      }
      if (machine.operatorId) {
        await User.updateOne({ _id: machine.operatorId }, { $pull: { assignedMachines: machine._id } }, { session });
      }

      machine.isDeleted = true;
      machine.deletedAt = new Date();
      machine.dealership = null;
      machine.assignedTo = null;
      machine.operatorId = null;
      await machine.save({ session });

      await session.commitTransaction();
      session.endSession();

      res.json({ success: true, message: "Machine soft-deleted successfully", machine });
    } catch (err: any) {
      await session.abortTransaction();
      session.endSession();
      res.status(500).json({ error: err.message });
    }
  }

  /**
   * Record live disinfection tap count.
   */
  static async recordTap(req: any, res: Response) {
    try {
      const { machineId } = req.params;
      const { tapCount, amount, initiatedBy, sessionId } = req.body;

      const { log, machine } = await MachineService.recordTap(
        machineId,
        Number(tapCount || 1),
        Number(amount || 0),
        initiatedBy || req.user.id,
        sessionId
      );

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
      res.status(500).json({ error: err.message });
    }
  }

  /**
   * Log fluid refill triggers.
   */
  static async updateRefill(req: any, res: Response) {
    try {
      const { machineId } = req.params;
      const { tapCount, containerSize = 5, usagePerTap = 0.012 } = req.body;

      const refill = await MachineService.updateRefill(
        machineId,
        Number(tapCount || 0),
        Number(containerSize),
        Number(usagePerTap)
      );

      res.json({
        success: true,
        message: 'Refill completed successfully',
        data: refill
      });
      res.json({
        success: true,
        message: 'Refill completed successfully',
        data: refill
      });
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }

  // Active sessions cache for tracking live disinfection cycles
  private static activeSessions = new Map<string, any>();

  /* ======================================================
     1. OPERATOR FEATURE ENDPOINTS
  ====================================================== */

  static async getOperatorMachines(req: any, res: Response) {
    try {
      const machines = await Machine.find({ operatorId: req.user.id, isDeleted: { $ne: true } });
      res.json(machines);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  static async startMachineTelemetry(req: any, res: Response) {
    try {
      const { machineId } = req.body;
      const operatorId = req.user.id;
      if (!machineId) return res.status(400).json({ success: false, message: "Machine ID is required" });

      const mqttClient = req.app.get('mqttClient');
      if (!mqttClient || !mqttClient.connected) {
        return res.status(503).json({ success: false, message: 'MQTT service not available' });
      }

      const machine = await Machine.findOne({ _id: machineId, operatorId, isDeleted: { $ne: true } });
      if (!machine) return res.status(404).json({ success: false, message: "Machine not found or not assigned" });

      if (MachineController.activeSessions.has(machineId)) {
        return res.status(400).json({ success: false, message: "Machine is already cleaning" });
      }

      const topic = `freshpod_vending_2025/${machine.machineId}`;
      const message = JSON.stringify({
        action: "START",
        amount: machine.costPerTap || 0.50,
        userId: operatorId,
        timestamp: Date.now()
      });

      mqttClient.publish(topic, message, { qos: 1 }, async (err: any) => {
        if (err) {
          return res.status(500).json({ success: false, message: 'Failed to send MQTT command' });
        }

        const session = {
          machineId,
          operatorId,
          startTime: new Date(),
          taps: 1,
          machineCode: machine.machineId,
          sessionId: `sess_${Date.now()}`
        };
        MachineController.activeSessions.set(machineId, session);

        const today = new Date().toISOString().split('T')[0];
        machine.totalTaps = (machine.totalTaps || 0) + 1;
        await machine.save();

        const log = await Log.create({
          machineId: machine.machineId,
          date: today,
          action: 'TAP_DISPENSED',
          status: 'completed',
          tapCount: 1,
          initiatedBy: operatorId,
          amount: machine.costPerTap || 0.50,
          sessionId: session.sessionId,
          sessionTaps: 1,
          timestamp: new Date(),
          metadata: { type: 'tap_record', topic, mqtt_message: message }
        });

        // Unify RFID/Telemetry disinfections by creating a paid Payment log record
        const paymentId = `PAY_TELEMETRY_${Date.now()}_${Math.random().toString(36).substr(2, 5)}`;
        try {
          await Payment.create({
            paymentId,
            machineId: machine.machineId,
            amount: machine.costPerTap || 0.50,
            method: 'MQTT',
            status: 'paid',
            customerName: 'Operator Run',
            customerEmail: 'N/A',
            customerPhone: 'N/A',
            timestamp: new Date()
          });
        } catch (payErr: any) {
          console.error('[DB] Failed to auto-create payment log entry:', payErr.message);
        }

        if ((global as any).broadcastLiveEvent) {
          (global as any).broadcastLiveEvent('TELEMETRY_UPDATE', {
            machineId: machine.machineId,
            totalTaps: machine.totalTaps,
            status: machine.status,
            lastTap: log
          });
          (global as any).broadcastLiveEvent('PAYMENT_UPDATE', {
            paymentId,
            machineId: machine.machineId,
            amount: machine.costPerTap || 0.50,
            method: 'MQTT',
            status: 'paid',
            timestamp: new Date()
          });
        }

        res.json({ success: true, message: "Start command sent successfully" });
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  static async getMachineTelemetryStatus(req: any, res: Response) {
    try {
      const { id } = req.params;
      const isCleaning = MachineController.activeSessions.has(id);
      res.json({ success: true, isCleaning });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  static async getMachineTelemetryHistory(req: any, res: Response) {
    try {
      const machine = await Machine.findOne({ _id: req.params.id, operatorId: req.user.id });
      if (!machine) return res.status(404).json({ error: "Machine not found" });

      const logs = await Log.find({ machineId: machine.machineId, action: 'TAP_DISPENSED' })
        .sort({ timestamp: -1 })
        .limit(20);
      res.json(logs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  static async getOperatorDashboard(req: any, res: Response) {
    try {
      const machines = await Machine.find({ operatorId: req.user.id, isDeleted: { $ne: true } });
      const machineIds = machines.map(m => m.machineId);

      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const tomorrow = new Date(today);
      tomorrow.setDate(tomorrow.getDate() + 1);

      // Sum exact payments instead of tap multiplication
      const paymentAggregation = await Payment.aggregate([
        {
          $match: {
            machineId: { $in: machineIds },
            status: 'paid',
            timestamp: { $gte: today, $lt: tomorrow }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$amount' }
          }
        }
      ]);
      const totalRevenueToday = paymentAggregation.length > 0 ? paymentAggregation[0].total : 0;

      const logsAggregation = await Log.aggregate([
        {
          $match: {
            machineId: { $in: machineIds },
            action: 'TAP_DISPENSED',
            timestamp: { $gte: today, $lt: tomorrow }
          }
        },
        {
          $group: {
            _id: null,
            totalCycles: { $sum: '$tapCount' }
          }
        }
      ]);
      const totalCyclesToday = logsAggregation.length > 0 ? logsAggregation[0].totalCycles : 0;

      let activeMachinesCount = 0;
      machines.forEach(m => {
        if (MachineController.activeSessions.has(m._id.toString())) {
          activeMachinesCount++;
        }
      });

      res.json({
        totalMachines: machines.length,
        activeMachines: activeMachinesCount,
        totalCyclesToday,
        totalRevenueToday,
        avgCyclesPerMachine: machines.length > 0 ? Math.round(totalCyclesToday / machines.length) : 0
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  static async getOperatorHistory(req: any, res: Response) {
    try {
      const machines = await Machine.find({ operatorId: req.user.id });
      const machineIds = machines.map(m => m.machineId);

      const logs = await Log.find({ machineId: { $in: machineIds }, action: 'TAP_DISPENSED' })
        .sort({ timestamp: -1 })
        .limit(100);

      res.json(logs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /* ======================================================
     2. DEALERSHIP FEATURE ENDPOINTS
  ====================================================== */

  static async getDealershipMachines(req: any, res: Response) {
    try {
      const machines = await Machine.find({ dealership: req.user.id, isDeleted: { $ne: true } })
        .populate("assignedTo", "name email phoneNumber");
      res.json(machines);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  static async getDealershipMachineData(req: any, res: Response) {
    try {
      const machines = await Machine.find({ dealership: req.user.id, isDeleted: { $ne: true } })
        .populate("assignedTo", "name email phoneNumber")
        .populate("operatorId", "name email");

      const machineIdStrings = machines.map(m => m.machineId);

      // Aggregated true total payment revenues
      const paymentsTotal = await Payment.aggregate([
        { $match: { machineId: { $in: machineIdStrings }, status: 'paid' } },
        { $group: { _id: '$machineId', total: { $sum: '$amount' } } }
      ]);
      const totalRevenueMap = {};
      paymentsTotal.forEach(p => { totalRevenueMap[p._id] = p.total; });

      const formatted = machines.map(machine => ({
        _id: machine._id.toString(),
        machineId: machine.machineId,
        qrId: machine.qrId || "",
        location: machine.location,
        costPerTap: machine.costPerTap,
        totalTaps: machine.totalTaps,
        status: machine.status,
        assignedTo: machine.assignedTo ? {
          id: (machine.assignedTo as any)._id?.toString() || machine.assignedTo.toString(),
          name: (machine.assignedTo as any).name || 'N/A',
          email: (machine.assignedTo as any).email || 'N/A'
        } : null,
        operatorId: machine.operatorId ? {
          id: (machine.operatorId as any)._id?.toString() || machine.operatorId.toString(),
          name: (machine.operatorId as any).name || 'N/A',
          email: (machine.operatorId as any).email || 'N/A'
        } : null,
        totalRevenue: totalRevenueMap[machine.machineId] || 0,
        createdAt: (machine as any).createdAt,
        updatedAt: (machine as any).updatedAt
      }));

      res.json(formatted);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  static async getDealershipDashboard(req: any, res: Response) {
    try {
      const totalMachines = await Machine.countDocuments({ dealership: req.user.id, isDeleted: { $ne: true } });
      const soldMachines = await Machine.countDocuments({ dealership: req.user.id, assignedTo: { $ne: null }, isDeleted: { $ne: true } });
      const availableMachines = totalMachines - soldMachines;

      const PROFIT_PER_MACHINE = 40000;
      const totalProfit = soldMachines * PROFIT_PER_MACHINE;

      res.json({
        totalMachines,
        soldMachines,
        availableMachines,
        totalProfit,
        profitPerMachine: PROFIT_PER_MACHINE
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  static async setMachineCost(req: any, res: Response) {
    try {
      const { id } = req.params;
      const { cost } = req.body;
      if (cost === undefined || cost < 0) return res.status(400).json({ message: "Invalid cost value" });

      const machine = await Machine.findById(id);
      if (!machine) return res.status(404).json({ message: "Machine not found" });

      machine.costPerTap = cost;
      await machine.save();

      // Check if there is Customer settings context to override also
      if (machine.assignedTo) {
        await CustomerMachineSettings.findOneAndUpdate(
          { customerId: machine.assignedTo, machineId: machine._id },
          { $set: { costPerTap: cost } },
          { upsert: true }
        );
      }

      res.json({ success: true, message: "Cost per tap updated successfully", machine });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  static async getDealershipAnalytics(req: any, res: Response) {
    try {
      const machines = await Machine.find({ dealership: req.user.id, isDeleted: { $ne: true } });
      const machineIdStrings = machines.map(m => m.machineId);

      const logs = await Log.find({ machineId: { $in: machineIdStrings }, action: 'TAP_DISPENSED' });
      const totalTaps = logs.reduce((acc, log) => acc + (log.tapCount || 0), 0);

      // Aggregated true payment revenues
      const paymentsAggregation = await Payment.aggregate([
        { $match: { machineId: { $in: machineIdStrings }, status: 'paid' } },
        { $group: { _id: null, total: { $sum: '$amount' } } }
      ]);
      const totalRevenue = paymentsAggregation.length > 0 ? paymentsAggregation[0].total : 0;

      const dailyData = {};
      logs.forEach(log => {
        dailyData[log.date] = (dailyData[log.date] || 0) + (log.tapCount || 0);
      });

      const dailyTrend = Object.entries(dailyData)
        .sort((a: any, b: any) => new Date(a[0]).getTime() - new Date(b[0]).getTime())
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
      res.status(500).json({ error: err.message });
    }
  }

  static async getDealershipAvailableMachines(req: any, res: Response) {
    try {
      const machines = await Machine.find({ dealership: req.user.id, assignedTo: null, isDeleted: { $ne: true } });
      res.json(machines);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /* ======================================================
     3. CUSTOMER FEATURE ENDPOINTS
  ====================================================== */

  static async getCustomerMachines(req: any, res: Response) {
    try {
      const machines = await Machine.find({ assignedTo: req.user.id, isDeleted: { $ne: true } });
      res.json(machines);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  static async setMachineRent(req: any, res: Response) {
    try {
      const { id } = req.params;
      const { rent } = req.body;
      if (rent === undefined || rent < 0) return res.status(400).json({ error: "Invalid rent value" });

      const machine = await Machine.findOne({ _id: id, assignedTo: req.user.id });
      if (!machine) return res.status(404).json({ error: "Machine not found" });

      const settings = await CustomerMachineSettings.findOneAndUpdate(
        { customerId: req.user.id, machineId: machine._id },
        { $set: { rentPerMonth: rent, machineCode: machine.machineId } },
        { upsert: true, new: true }
      );

      res.json({ success: true, settings });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  static async setMachineMaintenance(req: any, res: Response) {
    try {
      const { id } = req.params;
      const { maintenance } = req.body;
      if (maintenance === undefined || maintenance < 0) return res.status(400).json({ error: "Invalid maintenance cost" });

      const machine = await Machine.findOne({ _id: id, assignedTo: req.user.id });
      if (!machine) return res.status(404).json({ error: "Machine not found" });

      const settings = await CustomerMachineSettings.findOneAndUpdate(
        { customerId: req.user.id, machineId: machine._id },
        { $set: { maintenanceCostPerMonth: maintenance, machineCode: machine.machineId } },
        { upsert: true, new: true }
      );

      res.json({ success: true, settings });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  static async getCustomerDashboard(req: any, res: Response) {
    try {
      const customerId = req.user.id;
      const machines = await Machine.find({ assignedTo: customerId, isDeleted: { $ne: true } }).lean();
      const operatorCount = await User.countDocuments({ parent: customerId, role: "operator", isDeleted: { $ne: true } });

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
      const startOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
      const endOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0, 23, 59, 59);

      const machineIdStrings = machines.map(m => m.machineId);

      // Real payment revenues for current month
      const paymentAggregation = await Payment.aggregate([
        {
          $match: {
            machineId: { $in: machineIdStrings },
            status: 'paid',
            timestamp: { $gte: startOfMonth, $lte: endOfMonth }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$amount' }
          }
        }
      ]);
      const totalRevenueMonth = paymentAggregation.length > 0 ? paymentAggregation[0].total : 0;

      // Count monthly taps
      const logsAggregation = await Log.aggregate([
        {
          $match: {
            machineId: { $in: machineIdStrings },
            action: 'TAP_DISPENSED',
            timestamp: { $gte: startOfMonth, $lte: endOfMonth }
          }
        },
        {
          $group: {
            _id: '$machineId',
            taps: { $sum: '$tapCount' }
          }
        }
      ]);

      let totalTapsMonth = 0;
      let activeMachines = 0;
      logsAggregation.forEach(l => {
        totalTapsMonth += l.taps;
        if (l.taps > 0) activeMachines++;
      });

      res.json({
        totalMachines: machines.length,
        activeMachines,
        totalTapsMonth,
        totalRevenueMonth,
        avgDailyTaps: totalTapsMonth > 0 ? Math.round(totalTapsMonth / 30) : 0,
        totalOperators: operatorCount
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  static async getCustomerMachineDetails(req: any, res: Response) {
    try {
      const { machineId } = req.params;
      const customerId = req.user.id;

      const machine = await Machine.findOne({ machineId, assignedTo: customerId, isDeleted: { $ne: true } }).lean();
      if (!machine) return res.status(404).json({ success: false, message: "Machine not found" });

      const settings = await CustomerMachineSettings.findOne({ customerId, machineId: machine._id }).lean();

      const currentDate = new Date();
      const startOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth(), 1);
      const endOfMonth = new Date(currentDate.getFullYear(), currentDate.getMonth() + 1, 0, 23, 59, 59);

      // Real payment revenues for current month
      const paymentAggregation = await Payment.aggregate([
        {
          $match: {
            machineId: machine.machineId,
            status: 'paid',
            timestamp: { $gte: startOfMonth, $lte: endOfMonth }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$amount' }
          }
        }
      ]);
      const monthlyRevenue = paymentAggregation.length > 0 ? paymentAggregation[0].total : 0;

      const monthlyTapsResult = await Log.aggregate([
        {
          $match: {
            machineId: machine.machineId,
            action: 'TAP_DISPENSED',
            timestamp: { $gte: startOfMonth, $lte: endOfMonth }
          }
        },
        {
          $group: {
            _id: null,
            total: { $sum: '$tapCount' }
          }
        }
      ]);
      const monthlyTaps = monthlyTapsResult.length > 0 ? monthlyTapsResult[0].total : 0;

      const rentPerMonth = settings?.rentPerMonth || 0;
      const maintenanceCost = settings?.maintenanceCostPerMonth || 0;
      const netProfit = monthlyRevenue - (rentPerMonth + maintenanceCost);

      const recentLogs = await Log.find({ machineId: machine.machineId, action: "TAP_DISPENSED" })
        .sort({ timestamp: -1 })
        .limit(20)
        .lean();

      res.json({
        success: true,
        machine: {
          ...machine,
          totalRevenue: monthlyRevenue, // Monthly real revenue
          monthlyTaps,
          netProfit,
          settings
        },
        recentLogs
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  static async getCustomerAvailableMachinesDropdown(req: any, res: Response) {
    try {
      const machines = await Machine.find({ assignedTo: req.user.id, isDeleted: { $ne: true } })
        .select("machineId location status");
      res.json(machines);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  static async getCustomerDailyLogs(req: any, res: Response) {
    try {
      const machines = await Machine.find({ assignedTo: req.user.id, isDeleted: { $ne: true } });
      const machineIdStrings = machines.map(m => m.machineId);

      const dailyLogs = await Log.aggregate([
        { $match: { machineId: { $in: machineIdStrings }, action: 'TAP_DISPENSED' } },
        { $group: { _id: '$date', tapCount: { $sum: '$tapCount' } } },
        { $sort: { _id: -1 } },
        { $limit: 30 }
      ]);

      const formatted = dailyLogs.map(log => ({
        date: log._id,
        tapCount: log.tapCount
      }));

      res.json(formatted);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  static async getCustomerAllLogs(req: any, res: Response) {
    try {
      const machines = await Machine.find({ assignedTo: req.user.id, isDeleted: { $ne: true } });
      const machineIdStrings = machines.map(m => m.machineId);

      const logs = await Log.find({ machineId: { $in: machineIdStrings }, action: 'TAP_DISPENSED' })
        .sort({ timestamp: -1 })
        .limit(100);

      res.json(logs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  /* ======================================================
     4. ADMIN FEATURES & UTILS
  ====================================================== */

  static async getAdminAvailableMachines(req: any, res: Response) {
    try {
      const machines = await Machine.find({ assignedTo: null, isDeleted: { $ne: true } });
      res.json(machines);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  static async getAdminMachineLogs(req: any, res: Response) {
    try {
      const logs = await Log.find({ machineId: req.params.machineId })
        .sort({ timestamp: -1 })
        .limit(100);
      res.json(logs);
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  static async getAdminConsistencyCheck(req: any, res: Response) {
    try {
      const machines = await Machine.find({ isDeleted: { $ne: true } });
      const results = [];

      for (const machine of machines) {
        const logs = await Log.find({ machineId: machine.machineId });
        const calculatedTotal = logs.reduce((sum: number, log: any) => sum + (log.tapCount || 0), 0);

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
  }

  static async fixAdminConsistencyCheck(req: any, res: Response) {
    try {
      const machines = await Machine.find({ isDeleted: { $ne: true } });
      const fixes = [];

      for (const machine of machines) {
        const logs = await Log.find({ machineId: machine.machineId });
        const calculatedTotal = logs.reduce((sum: number, log: any) => sum + (log.tapCount || 0), 0);

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
  }

  static async getAdminTrash(req: any, res: Response) {
    try {
      const deletedUsers = await User.find({ isDeleted: true }).select("-password -refreshToken");
      const deletedMachines = await Machine.find({ isDeleted: true });

      res.json({
        success: true,
        users: deletedUsers,
        machines: deletedMachines
      });
    } catch (err: any) {
      res.status(500).json({ error: err.message });
    }
  }

  static async restoreAdminTrash(req: any, res: Response) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const { id } = req.params;
      const { type } = req.body; // "user" or "machine"

      if (!type || !["user", "machine"].includes(type)) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: "Invalid type. Must be 'user' or 'machine'." });
      }

      if (type === "user") {
        const user = await User.findById(id).session(session);
        if (!user) {
          await session.abortTransaction();
          session.endSession();
          return res.status(404).json({ message: "User not found" });
        }
        user.isDeleted = false;
        user.deletedAt = null;
        await user.save({ session });

        await session.commitTransaction();
        session.endSession();
        return res.json({ success: true, message: "User restored successfully", user });
      } else {
        const machine = await Machine.findById(id).session(session);
        if (!machine) {
          await session.abortTransaction();
          session.endSession();
          return res.status(404).json({ message: "Machine not found" });
        }
        machine.isDeleted = false;
        machine.deletedAt = null;
        await machine.save({ session });

        await session.commitTransaction();
        session.endSession();
        return res.json({ success: true, message: "Machine restored successfully", machine });
      }
    } catch (err: any) {
      await session.abortTransaction();
      session.endSession();
      res.status(500).json({ error: err.message });
    }
  }

  static async hardDeleteAdminTrash(req: any, res: Response) {
    const session = await mongoose.startSession();
    session.startTransaction();
    try {
      const { id } = req.params;
      const { type } = req.body;

      if (!type || !["user", "machine"].includes(type)) {
        await session.abortTransaction();
        session.endSession();
        return res.status(400).json({ message: "Invalid type. Must be 'user' or 'machine'." });
      }

      if (type === "user") {
        const user = await User.findById(id).session(session);
        if (!user) {
          await session.abortTransaction();
          session.endSession();
          return res.status(404).json({ message: "User not found" });
        }
        await user.deleteOne({ session });
        await session.commitTransaction();
        session.endSession();
        return res.json({ success: true, message: "User permanently deleted." });
      } else {
        const machine = await Machine.findById(id).session(session);
        if (!machine) {
          await session.abortTransaction();
          session.endSession();
          return res.status(404).json({ message: "Machine not found" });
        }
        await machine.deleteOne({ session });
        await session.commitTransaction();
        session.endSession();
        return res.json({ success: true, message: "Machine permanently deleted." });
      }
    } catch (err: any) {
      await session.abortTransaction();
      session.endSession();
      res.status(500).json({ error: err.message });
    }
  }
}

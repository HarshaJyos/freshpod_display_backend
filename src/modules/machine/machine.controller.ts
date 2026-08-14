import { Request, Response } from 'express';
import { MachineService } from './machine.service';
import { Machine, Log, SanitizationRefill } from './machine.model';
import User from '../user/user.model';
import Payment from '../payment/payment.model';
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
    } catch (err: any) {
      res.status(500).json({ success: false, message: err.message });
    }
  }
}

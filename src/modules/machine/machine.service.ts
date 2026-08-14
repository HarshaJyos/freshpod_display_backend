import mongoose from 'mongoose';
import { Machine, Log, SanitizationRefill, CustomerMachineSettings } from './machine.model';
import User from '../user/user.model';

export class MachineService {

  /**
   * Search machines by machineId.
   */
  static async searchMachines(queryStr: string, userId: string, role: string) {
    if (!queryStr.trim()) return [];

    const searchRegex = new RegExp(queryStr, 'i');
    let query: any = { machineId: { $regex: searchRegex }, isDeleted: { $ne: true } };

    if (role === 'admin') {
      return await Machine.find(query)
        .limit(10)
        .select('machineId location status assignedTo dealership');
    } else if (role === 'dealership') {
      const dealership = await User.findById(userId);
      if (!dealership) return [];
      
      return await Machine.find({
        _id: { $in: dealership.assignedMachines || [] },
        machineId: { $regex: searchRegex },
        isDeleted: { $ne: true }
      }).limit(10).select('machineId location status assignedTo');
    } else if (role === 'customer') {
      return await Machine.find({
        assignedTo: userId,
        machineId: { $regex: searchRegex },
        isDeleted: { $ne: true }
      }).limit(10).select('machineId location status dealership');
    }
    return [];
  }

  /**
   * Fetch details for a specific machine including recent logs and fluid calculations.
   */
  static async getMachineDetails(machineId: string, userId: string, role: string) {
    let machine: any = null;

    if (role === 'admin') {
      machine = await Machine.findOne({ machineId, isDeleted: { $ne: true } })
        .populate('assignedTo', 'name email phoneNumber')
        .populate('dealership', 'name email');
    } else if (role === 'dealership') {
      const dealership = await User.findById(userId);
      if (dealership) {
        machine = await Machine.findOne({
          machineId,
          _id: { $in: dealership.assignedMachines || [] },
          isDeleted: { $ne: true }
        }).populate('assignedTo', 'name email phoneNumber');
      }
    } else if (role === 'customer') {
      machine = await Machine.findOne({
        machineId,
        assignedTo: userId,
        isDeleted: { $ne: true }
      });
    }

    if (!machine) return null;

    const recentLogs = await Log.find({ machineId: machine.machineId })
      .sort({ timestamp: -1 })
      .limit(30);

    const refill = await SanitizationRefill.findOne({ machineId: machine.machineId });
    let sanitizationLevel = 100;
    if (refill) {
      const tapsSinceRefill = Math.max(0, machine.totalTaps - refill.tapCountAtRefill);
      const totalVolumeUsed = tapsSinceRefill * refill.usagePerTap;
      sanitizationLevel = Math.max(0, Math.min(100, ((refill.containerSize - totalVolumeUsed) / refill.containerSize) * 100));
    }

    return { machine, recentLogs, sanitizationLevel };
  }

  /**
   * Record a new disinfection tap run.
   */
  static async recordTap(machineId: string, tapCount: number, amount: number, initiatedBy: string, sessionId?: string) {
    const today = new Date().toISOString().split('T')[0];
    const machine = await Machine.findOne({ machineId, isDeleted: { $ne: true } });
    if (!machine) throw new Error('Machine not found');

    const log = await Log.create({
      machineId,
      date: today,
      tapCount: tapCount || 1,
      action: "TAP_DISPENSED",
      status: "completed",
      initiatedBy: initiatedBy || null,
      amount: amount || machine.costPerTap,
      sessionId: sessionId || `session_${Date.now()}`,
      sessionDuration: 0,
      sessionTaps: tapCount || 1,
      timestamp: new Date()
    });

    machine.totalTaps = (machine.totalTaps || 0) + (tapCount || 1);
    await machine.save();

    // Broadcast WS update globally
    if ((global as any).broadcastLiveEvent) {
      (global as any).broadcastLiveEvent('TELEMETRY_UPDATE', {
        machineId: machine.machineId,
        totalTaps: machine.totalTaps,
        status: machine.status,
        lastTap: log
      });
    }

    return { log, machine };
  }

  /**
   * Refill sanitization fluid levels.
   */
  static async updateRefill(machineId: string, tapCount: number, containerSize: number, usagePerTap: number) {
    const machine = await Machine.findOne({ machineId, isDeleted: { $ne: true } });
    if (!machine) throw new Error('Machine not found');

    let refill = await SanitizationRefill.findOne({ machineId });
    if (refill) {
      refill.tapCountAtRefill = tapCount;
      refill.containerSize = containerSize;
      refill.usagePerTap = usagePerTap;
      refill.start = new Date();
      await refill.save();
    } else {
      refill = new SanitizationRefill({
        machineId,
        tapCountAtRefill: tapCount,
        containerSize,
        usagePerTap,
        start: new Date()
      });
      await refill.save();
    }

    return refill;
  }
}

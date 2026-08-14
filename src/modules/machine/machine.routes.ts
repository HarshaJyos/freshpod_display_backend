import { Router } from 'express';
import { MachineController } from './machine.controller';
import { auth, allowRoles } from '../../middleware/auth';

// 1. ADMIN INVENTORY ROUTER
export const adminMachineRouter = Router();
adminMachineRouter.get("/machine/data", auth, MachineController.getMachinesData);
adminMachineRouter.post("/machine", auth, allowRoles("admin"), MachineController.createMachine);
adminMachineRouter.put("/machine/:id", auth, allowRoles("admin"), MachineController.updateMachine);
adminMachineRouter.delete("/machine/:id", auth, allowRoles("admin"), MachineController.deleteMachine);

// 2. USER TELEMETRY & OPERATION ROUTER
export const userMachineRouter = Router();
userMachineRouter.get("/search-machine", auth, MachineController.searchMachines);
userMachineRouter.get("/machine/:machineId", auth, MachineController.getMachineDetails);
userMachineRouter.post("/machine/:machineId/tap", auth, MachineController.recordTap);

// 3. LEGACY TELEMETRY REFILL ROUTER
export const refillMachineRouter = Router();
refillMachineRouter.post("/refill/:machineId", MachineController.updateRefill);

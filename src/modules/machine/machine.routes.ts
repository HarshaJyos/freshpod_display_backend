import { Router } from 'express';
import { MachineController } from './machine.controller';
import { auth, allowRoles } from '../../middleware/auth';

// 1. ADMIN INVENTORY ROUTER
export const adminMachineRouter = Router();
adminMachineRouter.get("/machine/data", auth, MachineController.getMachinesData);
adminMachineRouter.post("/machine", auth, allowRoles("admin"), MachineController.createMachine);
adminMachineRouter.put("/machine/:id", auth, allowRoles("admin"), MachineController.updateMachine);
adminMachineRouter.delete("/machine/:id", auth, allowRoles("admin"), MachineController.deleteMachine);

adminMachineRouter.get("/user/:id/available-machines", auth, allowRoles("admin"), MachineController.getAdminAvailableMachines);
adminMachineRouter.get("/machine/:machineId/logs", auth, allowRoles("admin"), MachineController.getAdminMachineLogs);
adminMachineRouter.get("/debug/consistency", auth, allowRoles("admin"), MachineController.getAdminConsistencyCheck);
adminMachineRouter.post("/debug/fix-consistency", auth, allowRoles("admin"), MachineController.fixAdminConsistencyCheck);
adminMachineRouter.get("/trash", auth, allowRoles("admin"), MachineController.getAdminTrash);
adminMachineRouter.post("/trash/:id/restore", auth, allowRoles("admin"), MachineController.restoreAdminTrash);
adminMachineRouter.delete("/trash/:id/hard-delete", auth, allowRoles("admin"), MachineController.hardDeleteAdminTrash);

// 2. USER TELEMETRY & OPERATION ROUTER
export const userMachineRouter = Router();
userMachineRouter.get("/search-machine", auth, MachineController.searchMachines);
userMachineRouter.get("/machine/:machineId", auth, MachineController.getMachineDetails);
userMachineRouter.post("/machine/:machineId/tap", auth, MachineController.recordTap);

// 3. LEGACY TELEMETRY REFILL ROUTER
export const refillMachineRouter = Router();
refillMachineRouter.post("/refill/:machineId", MachineController.updateRefill);

// 4. OPERATOR PANEL TELEMETRY ROUTER
export const operatorMachineRouter = Router();
operatorMachineRouter.get("/machines", auth, allowRoles("operator"), MachineController.getOperatorMachines);
operatorMachineRouter.post("/machine/start", auth, allowRoles("operator"), MachineController.startMachineTelemetry);
operatorMachineRouter.get("/machine/:id/status", auth, allowRoles("operator"), MachineController.getMachineTelemetryStatus);
operatorMachineRouter.get("/machine/:id/history", auth, allowRoles("operator"), MachineController.getMachineTelemetryHistory);
operatorMachineRouter.get("/dashboard", auth, allowRoles("operator"), MachineController.getOperatorDashboard);
operatorMachineRouter.get("/history", auth, allowRoles("operator"), MachineController.getOperatorHistory);

// 5. DEALERSHIP PORTAL ROUTER
export const dealershipMachineRouter = Router();
dealershipMachineRouter.get("/machines", auth, allowRoles("dealership"), MachineController.getDealershipMachines);
dealershipMachineRouter.get("/machine/data", auth, allowRoles("dealership"), MachineController.getDealershipMachineData);
dealershipMachineRouter.get("/dashboard", auth, allowRoles("dealership"), MachineController.getDealershipDashboard);
dealershipMachineRouter.put("/machine/:id/cost", auth, allowRoles("dealership"), MachineController.setMachineCost);
dealershipMachineRouter.get("/analytics", auth, allowRoles("dealership"), MachineController.getDealershipAnalytics);
dealershipMachineRouter.get("/available-machines", auth, allowRoles("dealership"), MachineController.getDealershipAvailableMachines);

// 6. CUSTOMER CONSOLE ROUTER
export const customerMachineRouter = Router();
customerMachineRouter.get("/machines", auth, allowRoles("customer"), MachineController.getCustomerMachines);
customerMachineRouter.put("/machine/:id/cost", auth, allowRoles("customer"), MachineController.setMachineCost);
customerMachineRouter.put("/machine/:id/rent", auth, allowRoles("customer"), MachineController.setMachineRent);
customerMachineRouter.put("/machine/:id/maintenance", auth, allowRoles("customer"), MachineController.setMachineMaintenance);
customerMachineRouter.get("/dashboard", auth, allowRoles("customer"), MachineController.getCustomerDashboard);
customerMachineRouter.get("/machine/:machineId", auth, allowRoles("customer"), MachineController.getCustomerMachineDetails);
customerMachineRouter.get("/customer-machines", auth, allowRoles("customer"), MachineController.getCustomerAvailableMachinesDropdown);
customerMachineRouter.get("/daily-logs", auth, allowRoles("customer"), MachineController.getCustomerDailyLogs);
customerMachineRouter.get("/all-logs", auth, allowRoles("customer"), MachineController.getCustomerAllLogs);

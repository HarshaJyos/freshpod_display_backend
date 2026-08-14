import { Router } from 'express';
import { ReportController } from './report.controller';
import { auth, allowRoles } from '../../middleware/auth';

// 1. ADMIN TICKETS RESOLUTION ROUTER
export const adminReportRouter = Router();
adminReportRouter.get("/reports", auth, allowRoles("admin"), ReportController.getReports);
adminReportRouter.post("/reports/:reportId/solve", auth, allowRoles("admin"), ReportController.solveReport);

// 2. CUSTOMER SUPPORT CONSOLE ROUTER
export const customerReportRouter = Router();
customerReportRouter.get("/reports", auth, allowRoles("customer"), ReportController.getReports);
customerReportRouter.post("/reports/create", auth, allowRoles("customer"), ReportController.createReport);
customerReportRouter.get("/reports/:reportId", auth, allowRoles("customer"), ReportController.getReportDetail);

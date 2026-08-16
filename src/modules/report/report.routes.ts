import { Router } from 'express';
import { ReportController } from './report.controller';
import { auth, allowRoles } from '../../middleware/auth';

// 1. ADMIN TICKETS RESOLUTION ROUTER
export const adminReportRouter = Router();
adminReportRouter.get("/reports", auth, allowRoles("admin"), ReportController.getReports);
adminReportRouter.post("/reports/:reportId/solve", auth, allowRoles("admin"), ReportController.solveReport);
adminReportRouter.put("/report/:reportId/solve", auth, allowRoles("admin"), ReportController.solveReport); // support legacy PUT solve
adminReportRouter.get("/report/:reportId", auth, allowRoles("admin"), ReportController.getReportDetail); // support singular detail
adminReportRouter.get("/reports/:reportId", auth, allowRoles("admin"), ReportController.getReportDetail); // support plural detail
adminReportRouter.delete("/report/:reportId", auth, allowRoles("admin"), ReportController.deleteReport); // support singular delete
adminReportRouter.delete("/reports/:reportId", auth, allowRoles("admin"), ReportController.deleteReport); // support plural delete

// 2. CUSTOMER SUPPORT CONSOLE ROUTER
export const customerReportRouter = Router();
customerReportRouter.get("/reports", auth, allowRoles("customer"), ReportController.getReports);
customerReportRouter.post("/reports/create", auth, allowRoles("customer"), ReportController.createReport);
customerReportRouter.get("/reports/:reportId", auth, allowRoles("customer"), ReportController.getReportDetail);
customerReportRouter.get("/report/:reportId", auth, allowRoles("customer"), ReportController.getReportDetail); // support singular customer detail

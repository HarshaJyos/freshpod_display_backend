import { Router } from 'express';
import { PaymentController } from './payment.controller';
import { auth, allowRoles } from '../../middleware/auth';

// 1. ADMIN HISTORICAL ROUTER
export const adminPaymentRouter = Router();
adminPaymentRouter.get("/payments/history", auth, PaymentController.getPaymentsHistory);

// 2. CLIENT GATEWAY INTERACTION ROUTER
export const apiPaymentRouter = Router();
apiPaymentRouter.post("/payment/create", PaymentController.createPaymentLink);
apiPaymentRouter.get("/payment/status", PaymentController.verifyPaymentStatus);
apiPaymentRouter.post("/payment/verify-manual", auth, PaymentController.verifyPaymentManual);
apiPaymentRouter.get("/payments/all", auth, PaymentController.getPaymentsHistory);

import { Router } from 'express';
import { UserController } from './user.controller';
import { auth, allowRoles } from '../../middleware/auth';

const router = Router();

// Authentication and session checks
router.post("/login", UserController.login);
router.post("/refresh-token", UserController.refreshToken);
router.post("/logout", auth, UserController.logout);
router.post("/change-password", auth, UserController.changePassword);

// Profile management
router.get("/profile", auth, UserController.getProfile);
router.put("/update-profile", auth, UserController.updateProfile);

// Directory management
router.get("/users", auth, allowRoles("admin", "dealership"), UserController.getUsers);
router.post("/createUser", auth, allowRoles("admin"), UserController.createUser);
router.put("/user/:id", auth, allowRoles("admin"), UserController.updateUser);
router.delete("/user/:id", auth, allowRoles("admin"), UserController.deleteUser);

export default router;

// 3. DEALERSHIP DIRECTORY OPERATIONS
export const dealershipUserRouter = Router();
dealershipUserRouter.post("/create-customer", auth, allowRoles("dealership"), UserController.createCustomer);
dealershipUserRouter.get("/customers", auth, allowRoles("dealership"), UserController.getCustomers);

// 4. CUSTOMER OPERATIONS FOR OPERATORS
export const customerUserRouter = Router();
customerUserRouter.post("/operator/create", auth, allowRoles("customer"), UserController.createOperator);
customerUserRouter.get("/operators", auth, allowRoles("customer"), UserController.getOperators);
customerUserRouter.delete("/operator/:operatorId", auth, allowRoles("customer"), UserController.deleteOperator);

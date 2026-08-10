import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';

// Verify JWT Middleware
export const auth = (req: any, res: Response, next: NextFunction) => {
  const header = req.headers.authorization;

  if (!header) {
    return res.status(401).json({ message: "No token provided" });
  }

  if (!header.startsWith("Bearer ")) {
    return res.status(401).json({ message: "Invalid token format" });
  }

  const token = header.split(" ")[1];

  try {
    const secret = process.env.JWT_SECRET;
    if (!secret) {
      throw new Error('JWT_SECRET is missing in environment variables');
    }
    const decoded = jwt.verify(token, secret) as { id: string; role: 'admin' | 'dealership' | 'customer' | 'operator' };
    req.user = {
      id: decoded.id,
      role: decoded.role
    };
    next();
  } catch (err: any) {
    if (err.name === "TokenExpiredError") {
      return res.status(401).json({ message: "Token expired" });
    }
    return res.status(401).json({ message: "Invalid token" });
  }
};

// Role-based access control Middleware
export const allowRoles = (...roles: string[]) => {
  return (req: any, res: Response, next: NextFunction) => {
    if (!req.user) {
      return res.status(401).json({ message: "Unauthorized" });
    }
    if (!roles.includes(req.user.role)) {
      return res.status(403).json({ message: "Forbidden" });
    }
    next();
  };
};

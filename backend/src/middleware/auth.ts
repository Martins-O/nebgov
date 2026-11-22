import { Request, Response, NextFunction } from "express";
import jwt from "jsonwebtoken";
import { requireJwtSecret } from "../config";

export interface AuthRequest extends Request {
  userId?: number;
  walletAddress?: string;
}

export const authenticate = (
  req: AuthRequest,
  res: Response,
  next: NextFunction,
) => {
  try {
    const token = req.headers.authorization?.split(" ")[1];

    if (!token) {
      return res.status(401).json({ error: "Authentication required" });
    }

    const decoded = jwt.verify(token, requireJwtSecret()) as {
      userId: number;
      walletAddress: string;
    };

    req.userId = decoded.userId;
    req.walletAddress = decoded.walletAddress;
    next();
  } catch (error) {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
};

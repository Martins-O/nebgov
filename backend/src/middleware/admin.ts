import { Request, Response, NextFunction } from "express";
import { createHash, timingSafeEqual } from "node:crypto";

function secretsMatch(provided: string, expected: string): boolean {
  const providedDigest = createHash("sha256").update(provided).digest();
  const expectedDigest = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedDigest, expectedDigest);
}

export function isAdmin(req: Request, res: Response, next: NextFunction) {
  const expectedSecret = process.env.ADMIN_SECRET;
  if (!expectedSecret) {
    return res.status(503).json({ error: "ADMIN_SECRET is not configured" });
  }

  const provided =
    req.header("ADMIN_SECRET") ??
    req.header("X-ADMIN-SECRET") ??
    req.header("admin_secret");

  if (!provided || !secretsMatch(provided, expectedSecret)) {
    return res.status(403).json({ error: "Admin authorization required" });
  }

  next();
}

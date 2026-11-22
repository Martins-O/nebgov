import { Router } from "express";
import { z } from "zod";
import jwt from "jsonwebtoken";
import crypto from "crypto";
import pool from "../db/pool";
import { validate } from "../middleware/validate";
import { logger } from "../logger";
import { requireJwtSecret } from "../config";

const router = Router();

const loginSchema = z.object({
  wallet_address: z.string().trim().min(10).max(56),
});

const ACCESS_TOKEN_EXPIRY = "15m";
const REFRESH_TOKEN_EXPIRY_DAYS = 7;

// Helper to hash refresh tokens
function hashToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

// Helper to generate refresh token
function generateRefreshToken(): string {
  return crypto.randomBytes(32).toString("hex");
}

// POST /auth/login - Wallet-signature-based login
router.post(
  "/login",
  validate({ body: loginSchema }),
  async (req, res) => {
    const walletAddress = (req.body.wallet_address as string).trim();

    try {
      // Find or create user
      const existing = await pool.query<{ id: number; wallet_address: string }>(
        "SELECT id, wallet_address FROM users WHERE wallet_address = $1",
        [walletAddress],
      );

      const userId =
        existing.rows[0]?.id ??
        (
          await pool.query<{ id: number }>(
            "INSERT INTO users (wallet_address) VALUES ($1) RETURNING id",
            [walletAddress],
          )
        ).rows[0].id;

      // Generate access token (short-lived)
      const accessToken = jwt.sign(
        { userId, walletAddress },
        requireJwtSecret(),
        { expiresIn: ACCESS_TOKEN_EXPIRY },
      );

      // Generate refresh token (long-lived)
      const refreshToken = generateRefreshToken();
      const tokenHash = hashToken(refreshToken);
      const expiresAt = new Date();
      expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_EXPIRY_DAYS);

      // Store refresh token in database
      await pool.query(
        "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
        [userId, tokenHash, expiresAt],
      );

      // Set refresh token as httpOnly cookie
      res.cookie("refreshToken", refreshToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "strict",
        maxAge: REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
      });

      res.json({
        accessToken,
        user_id: userId,
        wallet_address: walletAddress,
      });
    } catch (error) {
      logger.error({ err: error }, "Error in /auth/login");
      res.status(500).json({ error: "Failed to login" });
    }
  },
);

// POST /auth/refresh - Refresh access token
router.post("/refresh", async (req, res) => {
  const refreshToken = req.cookies.refreshToken;

  if (!refreshToken) {
    return res.status(401).json({ error: "Refresh token required" });
  }

  try {
    const tokenHash = hashToken(refreshToken);

    // Find refresh token in database
    const result = await pool.query<{
      id: number;
      user_id: number;
      expires_at: Date;
    }>(
      `SELECT rt.id, rt.user_id, rt.expires_at, u.wallet_address
       FROM refresh_tokens rt
       JOIN users u ON rt.user_id = u.id
       WHERE rt.token_hash = $1`,
      [tokenHash],
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ error: "Invalid refresh token" });
    }

    const tokenData = result.rows[0];

    // Check if token is expired
    if (new Date(tokenData.expires_at) < new Date()) {
      // Clean up expired token
      await pool.query("DELETE FROM refresh_tokens WHERE id = $1", [
        tokenData.id,
      ]);
      return res.status(401).json({ error: "Refresh token expired" });
    }

    // Delete old refresh token (rotation)
    await pool.query("DELETE FROM refresh_tokens WHERE id = $1", [
      tokenData.id,
    ]);

    // Generate new access token
    const accessToken = jwt.sign(
      {
        userId: tokenData.user_id,
        walletAddress: (result.rows[0] as any).wallet_address,
      },
      requireJwtSecret(),
      { expiresIn: ACCESS_TOKEN_EXPIRY },
    );

    // Generate new refresh token
    const newRefreshToken = generateRefreshToken();
    const newTokenHash = hashToken(newRefreshToken);
    const expiresAt = new Date();
    expiresAt.setDate(expiresAt.getDate() + REFRESH_TOKEN_EXPIRY_DAYS);

    // Store new refresh token
    await pool.query(
      "INSERT INTO refresh_tokens (user_id, token_hash, expires_at) VALUES ($1, $2, $3)",
      [tokenData.user_id, newTokenHash, expiresAt],
    );

    // Set new refresh token cookie
    res.cookie("refreshToken", newRefreshToken, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      maxAge: REFRESH_TOKEN_EXPIRY_DAYS * 24 * 60 * 60 * 1000,
    });

    res.json({ accessToken });
  } catch (error) {
    logger.error({ err: error }, "Error in /auth/refresh");
    res.status(500).json({ error: "Failed to refresh token" });
  }
});

// POST /auth/logout - Invalidate refresh token
router.post("/logout", async (req, res) => {
  const refreshToken = req.cookies.refreshToken;

  if (!refreshToken) {
    return res.status(200).json({ message: "Logged out" });
  }

  try {
    const tokenHash = hashToken(refreshToken);

    // Delete refresh token from database
    await pool.query("DELETE FROM refresh_tokens WHERE token_hash = $1", [
      tokenHash,
    ]);

    // Clear cookie
    res.clearCookie("refreshToken");

    res.json({ message: "Logged out successfully" });
  } catch (error) {
    logger.error({ err: error }, "Error in /auth/logout");
    res.status(500).json({ error: "Failed to logout" });
  }
});

export default router;

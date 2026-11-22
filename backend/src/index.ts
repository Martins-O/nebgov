import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import rateLimit from "express-rate-limit";
import cookieParser from "cookie-parser";
import competitionsRouter from "./routes/competitions";
import leaderboardRouter from "./routes/leaderboard";
import authRouter from "./routes/auth";
import notificationsRouter from "./routes/notifications";
import securityRouter from "./routes/security";
import relayerRouter from "./routes/relayer";
import signalingRouter from "./routes/signaling";
import governanceTuningRouter from "./routes/governance-tuning";
import proposalSimulationRouter from "./routes/proposal-simulation";
import votingRewardsRouter from "./routes/voting-rewards";
import proposalAmendmentsRouter from "./routes/proposal-amendments";
import { securityMonitor } from "./services/security-monitor";
import { notificationProcessor } from "./jobs/notification-processor";
import { deliveryRetry } from "./jobs/delivery-retry";
import { signalAnchorService } from "./jobs/signal-anchor";
import { governanceTuningAnalyzer } from "./jobs/governance-tuning-analyzer";
import { votingRewardsEpochService } from "./jobs/voting-rewards-epoch";
import { treasuryStreamsExecutor } from "./jobs/treasury-streams-executor";
import { jobHealthTracker } from "./jobs/health-tracker";
import { runBackendMigrations } from "./db/migrationRunner";
import pino from "pino";
import pinoHttp from "pino-http";
import swaggerUi from "swagger-ui-express";
import { generateOpenApiDocument } from "./openapi";
import { logger } from "./logger";
import { validateConfig } from "./config";

dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001;

// Rate limiters
const globalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests, please try again later." },
});

const joinLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 5,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many join attempts" },
});

const leaderboardLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many requests" },
});

// Submitting a signed permit costs the relayer a real transaction fee, so
// this is deliberately tighter than the other per-IP limiters. The
// per-delegator-address daily budget is enforced separately in the route
// itself (backend/src/routes/relayer.ts), against relayer_permit_log.
const relayerLimiter = rateLimit({
  windowMs: 60 * 1000, // 1 minute
  max: 10,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: "Too many relayer requests" },
});

// Middleware
app.use(
  cors({
    origin: process.env.FRONTEND_URL || "http://localhost:3000",
    credentials: true,
  }),
);
app.use(express.json());
app.use(cookieParser());

// Logging middleware
app.use(
  pinoHttp({
    logger,
    autoLogging: {
      ignore: (req) => req.url === "/health",
    },
  }),
);

// Swagger / OpenAPI documentation — served in development only
if (process.env.NODE_ENV !== "production") {
  app.get("/openapi.json", (_req, res) => {
    res.setHeader("Content-Type", "application/json");
    res.send(generateOpenApiDocument());
  });
  app.use("/docs", swaggerUi.serve, swaggerUi.setup(generateOpenApiDocument()));
}

// Health check — exempt from rate limiting
app.get("/health", (_req, res) => {
  const jobHealth = jobHealthTracker.getHealthReport();
  const systemReady = jobHealthTracker.isSystemReady();
  
  res.json({ 
    status: systemReady ? "ok" : "degraded", 
    timestamp: new Date().toISOString(),
    jobs: jobHealth,
    ready: systemReady
  });
});

// Apply global limiter to all routes below
app.use(globalLimiter);

// Routes
app.use("/auth", authRouter);
app.post("/competitions/:id/join", joinLimiter);
app.post("/competitions/:id/leave", joinLimiter);
app.use("/competitions", competitionsRouter);
app.use("/leaderboard/history", leaderboardLimiter);
app.use("/leaderboard", leaderboardRouter);
app.use("/notifications", notificationsRouter);
app.use("/security", securityRouter);
app.use("/relayer", relayerLimiter);
app.use("/relayer", relayerRouter);
app.use("/signaling", signalingRouter);
app.use("/governance-tuning", governanceTuningRouter);
app.use("/proposal-simulation", proposalSimulationRouter);
app.use("/voting-rewards", votingRewardsRouter);
app.use("/proposals", proposalAmendmentsRouter);

// Error handling
app.use(
  (
    err: Error,
    req: express.Request,
    res: express.Response,
    next: express.NextFunction,
  ) => {
    logger.error({ err }, "Unhandled error");
    res.status(500).json({ error: "Internal server error" });
  },
);

async function bootstrap(): Promise<void> {
  validateConfig();
  await runBackendMigrations();
  app.listen(PORT, () => {
    logger.info({ port: PORT }, "Backend server running");

    // Start the security monitor
    securityMonitor.start().catch((err) => {
      logger.error({ err }, "Failed to start security monitor");
    });

    // Start the notification engine's background jobs
    notificationProcessor.start();
    deliveryRetry.start();

    // Start the signaling poll finalizer / on-chain anchor job
    signalAnchorService.start();

    // Start the governance tuning recommender (issue #998)
    governanceTuningAnalyzer.start();

    // Start the voting participation rewards epoch service (issue #1011)
    votingRewardsEpochService.start();

    // Pay due intervals on treasury streams, only when the contract is configured
    if (process.env.TREASURY_STREAMS_CONTRACT_ID) {
      treasuryStreamsExecutor.start();
    }
  });
}

if (process.env.NODE_ENV !== "test") {
  bootstrap().catch((err: unknown) => {
    console.error("Failed to start:", err);
    process.exit(1);
  });
}

export default app;

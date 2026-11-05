import express, { type Express } from "express";
import { healthRouter } from "./routes/health.js";
import { leaderboardRouter } from "./routes/leaderboard.js";
import { playersRouter } from "./routes/players.js";
import { statsRouter } from "./routes/stats.js";

export function createServer(): Express {
  const app = express();

  // Public read-only API for a static browser client (file:// / any static
  // host) -- no cookies, no auth, nothing to protect against CSRF, so a
  // blanket allow-all is the correct and simplest CORS policy here, not a
  // shortcut around a harder problem.
  app.use((_req, res, next) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Methods", "GET, OPTIONS");
    next();
  });

  app.use(healthRouter);
  app.use(leaderboardRouter);
  app.use(playersRouter);
  app.use(statsRouter);

  app.use((_req, res) => {
    res.status(404).json({ error: "not found" });
  });

  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
    console.error("[api] unhandled error:", err);
    res.status(500).json({ error: "internal error" });
  });

  return app;
}

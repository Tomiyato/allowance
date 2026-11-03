import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import cookieParser from "cookie-parser";
import express from "express";
import { aiLabel, config } from "./config.ts";
import { apiRouter, errorHandler, paypalReturnRouter, sessionMiddleware } from "./routes.ts";

const app = express();
app.set("trust proxy", 1); // Render terminates TLS in front of us
app.disable("x-powered-by");
app.use(express.json({ limit: "1mb" }));
app.use(cookieParser());

app.get("/healthz", (_req, res) => {
  res.json({ ok: true });
});

app.use("/api", sessionMiddleware, apiRouter());
app.use("/paypal", sessionMiddleware, paypalReturnRouter());

// Built frontend (web/dist) with SPA fallback, when it exists.
const dist = fileURLToPath(new URL("../web/dist", import.meta.url));
if (existsSync(dist)) {
  app.use(express.static(dist, { index: false, maxAge: "1h" }));
  app.use((req, res, next) => {
    if (req.method !== "GET" && req.method !== "HEAD") return next();
    res.sendFile("index.html", { root: dist, maxAge: 0 });
  });
} else {
  app.get("/", (_req, res) => {
    res.type("text").send("Allowance API is running. Frontend not built yet (web/dist missing). Try GET /api/state.");
  });
}

app.use(errorHandler);

const server = app.listen(config.port, () => {
  console.log(
    `[server] Allowance on http://localhost:${config.port} | payment=${config.paymentMode} products=${config.productSource}` +
      `${config.demoInjection ? " (demo injection on)" : ""} ai=${aiLabel()}`,
  );
});
server.on("error", (err: NodeJS.ErrnoException) => {
  console.error(`[server] cannot listen on port ${config.port}: ${err.code ?? err.message}. Set PORT to a free port.`);
  process.exit(1);
});

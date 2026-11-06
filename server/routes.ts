// HTTP API (SPEC §9).
import { Router, type NextFunction, type Request, type Response } from "express";
import { handleChat } from "./agent/chat.ts";
import { parseMandate } from "./agent/parse-mandate.ts";
import { config } from "./config.ts";
import {
  approvePurchase,
  cancelApproval,
  completePurchaseApproval,
  createMandate,
  finalizeApproval,
  HttpError,
  refundPurchase,
  recordPayPalWebhook,
  rejectPurchase,
  remaining,
  revokeMandate,
  simulateHijackedAgent,
  startApproval,
  type PayPalWebhookEvent,
} from "./service.ts";
import { handlePayPalWebhook } from "./paypal/webhooks.ts";
import type { ProposePurchaseOutput } from "../shared/types.ts";
import { appState, createSession, findSessionByMandate, getSession, type Session } from "./store.ts";

const COOKIE = "allowance_sid";

declare global {
  // eslint-disable-next-line @typescript-eslint/no-namespace
  namespace Express {
    interface Request {
      session_: Session;
    }
  }
}

/** Anonymous session via httpOnly cookie; every new visitor gets a fresh demo state. */
export function sessionMiddleware(req: Request, res: Response, next: NextFunction) {
  const sid = req.cookies?.[COOKIE] as string | undefined;
  let s = sid ? getSession(sid) : undefined;
  if (!s) {
    s = createSession();
    res.cookie(COOKIE, s.id, {
      httpOnly: true,
      sameSite: "lax", // lax so the cookie survives the top-level redirect back from PayPal
      secure: config.production,
      maxAge: 7 * 24 * 3600 * 1000,
      path: "/",
    });
  }
  req.session_ = s;
  next();
}

export function baseUrl(req: Request): string {
  return config.publicUrl ?? `${req.protocol}://${req.get("host")}`;
}

type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
const wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => {
  Promise.resolve(fn(req, res)).catch(next);
};

export function apiRouter(): Router {
  const r = Router();

  r.get("/state", (req, res) => {
    res.json(appState(req.session_));
  });

  r.post(
    "/mandates/parse",
    wrap(async (req, res) => {
      const text = typeof req.body?.text === "string" ? req.body.text.trim() : "";
      if (!text) throw new HttpError(400, "Body must be { text: string }");
      if (text.length > 2000) throw new HttpError(400, "Text is too long (max 2000 characters).");
      res.json(await parseMandate(text));
    }),
  );

  r.post(
    "/mandates",
    wrap((req, res) => {
      const mandate = createMandate(req.session_, req.body?.mandate);
      res.status(201).json({ mandate });
    }),
  );

  r.post(
    "/mandates/:id/approve",
    wrap(async (req, res) => {
      const approveUrl = await startApproval(req.session_, String(req.params.id), baseUrl(req));
      res.json({ approveUrl });
    }),
  );

  r.post(
    "/mandates/:id/revoke",
    wrap(async (req, res) => {
      res.json({ mandate: await revokeMandate(req.session_, String(req.params.id)) });
    }),
  );

  r.post("/chat", wrap((req, res) => handleChat(req, res, req.session_, baseUrl(req))));

  r.post(
    "/purchases/:id/approve",
    wrap(async (req, res) => {
      res.json({ purchase: await approvePurchase(req.session_, String(req.params.id), baseUrl(req)) });
    }),
  );

  r.post(
    "/purchases/:id/reject",
    wrap((req, res) => {
      res.json({ purchase: rejectPurchase(req.session_, String(req.params.id)) });
    }),
  );

  r.post(
    "/purchases/:id/refund",
    wrap(async (req, res) => {
      const reason = typeof req.body?.reason === "string" ? req.body.reason : "Refund requested by the user";
      res.json({ purchase: await refundPurchase(req.session_, String(req.params.id), reason, "user") });
    }),
  );

  // Safety demo: replay what a prompt-injected agent would call (propose_purchase of the injection
  // listing, qty 5) through the normal proposal path. Same policy, same rail; ledger rows are labelled.
  r.post(
    "/redteam/hijack",
    wrap(async (req, res) => {
      const purchase = await simulateHijackedAgent(req.session_, baseUrl(req));
      const out: ProposePurchaseOutput = { purchase, remaining: remaining(req.session_) };
      res.json(out);
    }),
  );

  // POST /api/paypal/webhook is mounted in index.ts before the JSON parser and the session cookie
  // (paypalWebhookHandler below): it needs the raw body, and PayPal has no session.

  r.use((_req, res) => {
    res.status(404).json({ error: "Not found" });
  });

  return r;
}

/** Browser-facing PayPal return/cancel URLs (top-level navigations, so redirects, not JSON). */
export function paypalReturnRouter(): Router {
  const r = Router();

  r.get(
    "/return",
    wrap(async (req, res) => {
      const mandateId = typeof req.query.mandate === "string" ? req.query.mandate : null;
      const purchaseId = typeof req.query.purchase === "string" ? req.query.purchase : null;
      const token = typeof req.query.token === "string" ? req.query.token : "";
      try {
        if (mandateId) {
          // Prefer the cookie session; fall back to lookup by id if the cookie did not survive the round trip.
          const s = req.session_.mandate?.id === mandateId ? req.session_ : (findSessionByMandate(mandateId) ?? req.session_);
          await finalizeApproval(s, mandateId, token);
          res.redirect(302, "/agent");
        } else if (purchaseId) {
          await completePurchaseApproval(req.session_, purchaseId);
          res.redirect(302, "/agent");
        } else {
          res.redirect(302, "/mandate?error=missing_return_params");
        }
      } catch (e) {
        res.redirect(302, `/mandate?error=${encodeURIComponent((e as Error).message.slice(0, 200))}`);
      }
    }),
  );

  r.get("/cancel", (req, res) => {
    const mandateId = typeof req.query.mandate === "string" ? req.query.mandate : null;
    if (mandateId) {
      try {
        cancelApproval(req.session_, mandateId);
      } catch {
        /* unknown mandate: nothing to cancel */
      }
      res.redirect(302, "/mandate?cancelled=1");
    } else {
      res.redirect(302, "/agent?cancelled=1");
    }
  });

  return r;
}

/**
 * POST /api/paypal/webhook. Mount with a raw body parser and without sessionMiddleware:
 *   app.post("/api/paypal/webhook", express.raw({ type: "*\/*" }), paypalWebhookHandler)
 * Verified events become one "paypal.webhook" ledger row in the session that owns the resource.
 */
export const paypalWebhookHandler = wrap(async (req, res) => {
  const out = await handlePayPalWebhook({ headers: req.headers, rawBody: req.body as Buffer | undefined }, (event) =>
    recordPayPalWebhook(event as PayPalWebhookEvent),
  );
  res.status(out.status).json(out.body);
});

export function errorHandler(err: unknown, _req: Request, res: Response, _next: NextFunction) {
  if (res.headersSent) {
    res.end();
    return;
  }
  if (err instanceof HttpError) {
    res.status(err.status).json({ error: err.message });
    return;
  }
  if ((err as any)?.type === "entity.parse.failed") {
    res.status(400).json({ error: "Invalid JSON body" });
    return;
  }
  console.error("[server] unhandled error:", err);
  res.status(500).json({ error: "Internal server error" });
}

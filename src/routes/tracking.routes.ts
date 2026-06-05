import { Router, type Request, type Response } from "express";
import rateLimit from "express-rate-limit";
import {
  trackingPixel,
  recordOpen,
  recordClick,
  verifyClickSig,
  fromB64url,
  visitorHash,
} from "../services/email-tracking.service";
import { onEmailOpened, onEmailClicked } from "../services/email-events.service";

// ============================================================================
// EMAIL TRACKING — PUBLIC routes /api/t/* (Sprint 10)
// No auth. Never error to the visitor: always serve the gif / a redirect, even
// on internal failure. Recording + automation emits are fire-and-forget.
// ============================================================================

const router = Router();

// Lenient — image proxies (Apple MPP / Gmail) can pre-fetch the pixel a lot.
const limiter = rateLimit({
  windowMs: 60 * 1000,
  max: 300,
  standardHeaders: true,
  legacyHeaders: false,
  // On limit, still serve a gif rather than a 429 page to the email client.
  handler: (_req, res) => {
    res.set({ "Content-Type": "image/gif", "Cache-Control": "no-store" });
    res.status(200).end(trackingPixel());
  },
});

const SAFE_FALLBACK = "https://zyrix.co";

function clientIp(req: Request): string {
  return (req.ip || (req.headers["x-forwarded-for"] as string) || "").split(",")[0].trim();
}

// Open pixel.
router.get("/o/:token", limiter, (req: Request, res: Response) => {
  const token = String(req.params.token || "");
  const ua = String(req.headers["user-agent"] || "");
  const vhash = visitorHash(clientIp(req), ua);
  // Fire-and-forget so the pixel is served instantly; emit on new opens.
  recordOpen(token, vhash, ua)
    .then((r) => onEmailOpened(r))
    .catch(() => {});
  res.set({
    "Content-Type": "image/gif",
    "Cache-Control": "no-store, no-cache, must-revalidate, private",
    Pragma: "no-cache",
  });
  res.status(200).end(trackingPixel());
});

// Click redirect (signed; whitelist-validate the decoded URL before 302).
router.get("/c/:token", limiter, (req: Request, res: Response) => {
  const token = String(req.params.token || "");
  const u = String(req.query.u || "");
  const s = String(req.query.s || "");
  try {
    if (u && s && verifyClickSig(token, u, s)) {
      const decoded = fromB64url(u);
      if (/^https?:\/\//i.test(decoded)) {
        const ua = String(req.headers["user-agent"] || "");
        recordClick(token, decoded, visitorHash(clientIp(req), ua), ua)
          .then((r) => onEmailClicked(r, decoded))
          .catch(() => {});
        res.redirect(302, decoded);
        return;
      }
    }
  } catch {
    /* fall through to safe fallback */
  }
  res.redirect(302, SAFE_FALLBACK);
});

export default router;

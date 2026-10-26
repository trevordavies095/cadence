import type { MiddlewareHandler } from "hono";
import { isDisclaimerAccepted } from "../disclaimer/store.js";

/** Block gated routes until the first-run disclaimer has been accepted. */
export const requireDisclaimer: MiddlewareHandler = async (c, next) => {
  const accepted = await isDisclaimerAccepted();
  if (!accepted) {
    return c.json({ error: "disclaimer_required" }, 403);
  }
  await next();
};

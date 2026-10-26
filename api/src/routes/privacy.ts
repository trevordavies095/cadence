import { Hono } from "hono";
import { PRIVACY_COPY } from "../privacy/copy.js";

export const privacyRoutes = new Hono();

/** Public privacy transparency copy — no disclaimer gate (linked from first-run). */
privacyRoutes.get("/privacy", (c) => c.json(PRIVACY_COPY));

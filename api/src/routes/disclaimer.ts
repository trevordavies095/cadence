import { Hono } from "hono";
import { acceptDisclaimer, getDisclaimerState } from "../disclaimer/store.js";

export const disclaimerRoutes = new Hono();

disclaimerRoutes.get("/disclaimer", async (c) => {
  const state = await getDisclaimerState();
  return c.json(state);
});

disclaimerRoutes.post("/disclaimer/accept", async (c) => {
  const state = await acceptDisclaimer();
  return c.json(state);
});

import { DodoPayments } from "dodopayments";

let cachedDodo: DodoPayments | null = null;

export function getDodoClient(): DodoPayments {
  if (cachedDodo) return cachedDodo;

  const bearerToken = process.env.DODO_PAYMENTS_API_KEY;
  if (!bearerToken) {
    throw new Error("DODO_PAYMENTS_API_KEY is not configured");
  }

  const isLive = process.env.DODO_PAYMENTS_MODE === "live";

  cachedDodo = new DodoPayments({
    bearerToken,
    environment: isLive ? "live_mode" : "test_mode",
    webhookKey: process.env.DODO_PAYMENTS_WEBHOOK_KEY,
  });

  return cachedDodo;
}

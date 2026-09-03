import { NextRequest } from "next/server";
import { db } from "@/lib/prisma";
import { getDodoClient } from "@/lib/dodo";
import { PLANS, PRICING_PLANS } from "@/lib/constants";
import type { Plan } from "@/types/plans";

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const headersRecord: Record<string, string> = {};
  request.headers.forEach((value, key) => {
    headersRecord[key.toLowerCase()] = value;
  });

  let event;
  try {
    const dodo = getDodoClient();
    event = dodo.webhooks.unwrap(rawBody, {
      headers: headersRecord,
      key: process.env.DODO_PAYMENTS_WEBHOOK_KEY,
    });
  } catch (err) {
    console.error("[dodo-webhook] signature verification failed:", err);
    return Response.json({ message: "Invalid signature" }, { status: 400 });
  }

  const eventType = event.type;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const payload = event.data as any;

  console.log(`[dodo-webhook] received event: ${eventType}`, {
    id: payload?.id,
    productId: payload?.product_id,
    metadata: payload?.metadata,
  });

  if (
    eventType === "subscription.active" ||
    eventType === "subscription.renewed" ||
    eventType === "payment.succeeded"
  ) {
    const metadata = payload?.metadata || {};
    const userId = metadata.userId as string | undefined;
    const customerEmail = payload?.customer?.email as string | undefined;
    const productId = payload?.product_id as string | undefined;

    // Resolve plan key from metadata or product ID
    let planKey: Plan = (metadata.planKey as Plan) || "free";
    if (!metadata.planKey && productId) {
      const matched = PRICING_PLANS.find((p) => p.productId === productId);
      if (matched && matched.key !== "free") {
        planKey = matched.key as Plan;
      }
    }

    if (planKey === "free") {
      return Response.json({ received: true });
    }

    const creditsToAdd = PLANS[planKey].credits;

    try {
      if (userId) {
        await db.user.update({
          where: { id: userId },
          data: {
            plan: planKey,
            credits: { increment: creditsToAdd },
          },
        });
        console.log(`[dodo-webhook] credited user ${userId} with ${creditsToAdd} credits for plan ${planKey}`);
      } else if (customerEmail) {
        await db.user.update({
          where: { email: customerEmail },
          data: {
            plan: planKey,
            credits: { increment: creditsToAdd },
          },
        });
        console.log(`[dodo-webhook] credited user by email ${customerEmail} with ${creditsToAdd} credits for plan ${planKey}`);
      }
    } catch (dbErr) {
      console.error("[dodo-webhook] failed to update user in database:", dbErr);
      return Response.json({ message: "Database update error" }, { status: 500 });
    }
  }

  return Response.json({ received: true });
}

export const runtime = "nodejs";

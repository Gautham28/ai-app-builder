import { auth } from "@clerk/nextjs/server";
import { NextRequest } from "next/server";
import { checkUser } from "@/lib/checkUser";
import { db } from "@/lib/prisma";
import { getDodoClient } from "@/lib/dodo";
import { PRICING_PLANS } from "@/lib/constants";

export async function POST(request: NextRequest) {
  const { userId: clerkId } = await auth();
  if (!clerkId) {
    return Response.json({ message: "Unauthorized" }, { status: 401 });
  }

  let user = await db.user.findUnique({
    where: { clerkId },
    select: { id: true, email: true, name: true, clerkId: true },
  });

  if (!user) {
    await checkUser();
    user = await db.user.findUnique({
      where: { clerkId },
      select: { id: true, email: true, name: true, clerkId: true },
    });
  }

  if (!user) {
    return Response.json({ message: "User not found" }, { status: 404 });
  }

  let body: { planKey?: string };
  try {
    body = await request.json();
  } catch {
    return Response.json({ message: "Invalid JSON" }, { status: 400 });
  }

  const { planKey } = body;
  const plan = PRICING_PLANS.find((p) => p.key === planKey);

  if (!plan || !plan.productId) {
    return Response.json({ message: "Invalid plan selected" }, { status: 400 });
  }

  try {
    const dodo = getDodoClient();

    const origin =
      request.headers.get("origin") ||
      request.headers.get("referer") ||
      process.env.NEXT_PUBLIC_APP_URL ||
      "https://ai-app-builder-ten-mu.vercel.app";

    const session = await dodo.checkoutSessions.create({
      product_cart: [
        {
          product_id: plan.productId,
          quantity: 1,
        },
      ],
      customer: {
        email: user.email,
        name: user.name || "Customer",
      },
      metadata: {
        userId: user.id,
        clerkId: user.clerkId,
        planKey: plan.key,
      },
      return_url: `${origin}/workspace?upgraded=true`,
    });

    return Response.json({ checkoutUrl: session.checkout_url });
  } catch (error) {
    console.error("[dodo-checkout] failed:", error);
    const message =
      error instanceof Error ? error.message : "Failed to create checkout";
    return Response.json({ message }, { status: 500 });
  }
}

import { auth, currentUser } from "@clerk/nextjs/server";
import { db } from "./prisma";
import { PLANS } from "./constants";
import type { Plan } from "@/types/plans";

const getCurrentPlan = async (): Promise<Plan> => {
  try {
    const { has } = await auth();
    if (typeof has === "function") {
      if (has({ plan: "pro" })) return "pro";
      if (has({ plan: "starter" })) return "starter";
    }
  } catch {
    // Ignore plan check errors and default to free
  }
  return "free";
};

export const checkUser = async () => {
  let user;
  try {
    user = await currentUser();
  } catch (error) {
    console.error("[checkUser] currentUser error:", error);
    return null;
  }

  if (!user) return null;

  const email = user.emailAddresses[0]?.emailAddress;
  if (!email) {
    console.error("[checkUser] Clerk user has no email address:", user.id);
    return null;
  }

  const profile = {
    name: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim() || "User",
    email,
    imageUrl: user.imageUrl ?? "",
  };

  try {
    const currentPlan = await getCurrentPlan();

    // 1. Try finding user by clerkId
    let existing = await db.user.findUnique({
      where: { clerkId: user.id },
    });

    // 2. If not found by clerkId, find by email to handle new Clerk instance / re-key
    if (!existing) {
      existing = await db.user.findUnique({
        where: { email },
      });

      if (existing) {
        existing = await db.user.update({
          where: { id: existing.id },
          data: { clerkId: user.id, ...profile },
        });
      } else {
        existing = await db.user.create({
          data: {
            clerkId: user.id,
            ...profile,
            credits: PLANS.free.credits,
            plan: "free",
          },
        });
      }
    } else {
      // User exists with matching clerkId, ensure profile is up to date
      existing = await db.user.update({
        where: { id: existing.id },
        data: profile,
      });
    }

    if (existing.plan === currentPlan) return existing;

    // Only top up credits on upgrade (positive delta), not on downgrade
    const existingPlanCredits = PLANS[existing.plan as Plan]?.credits ?? 0;
    const newPlanCredits = PLANS[currentPlan]?.credits ?? 10;
    const creditDelta = newPlanCredits - existingPlanCredits;

    // Guard on the old plan so concurrent requests cannot double-credit
    const { count } = await db.user.updateMany({
      where: { id: existing.id, plan: existing.plan },
      data: {
        plan: currentPlan,
        credits:
          creditDelta > 0 ? existing.credits + creditDelta : existing.credits,
      },
    });

    if (count === 0) return existing;

    return await db.user.findUnique({ where: { id: existing.id } });
  } catch (error) {
    console.error("[checkUser] failed to sync user", user.id, error);
    return null;
  }
};

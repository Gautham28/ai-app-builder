import { auth, currentUser } from "@clerk/nextjs/server";
import { db } from "./prisma";
import { PLANS } from "./constants";
import type { Plan } from "@/types/plans";

const getCurrentPlan = async (): Promise<Plan> => {
  const { has } = await auth();
  if (has({ plan: "pro" })) return "pro";
  if (has({ plan: "starter" })) return "starter";
  return "free";
};

function isUniqueConstraintError(error: unknown, target: string): boolean {
  if (!error || typeof error !== "object") return false;
  const candidate = error as { code?: string; meta?: { target?: unknown } };
  if (candidate.code !== "P2002") return false;
  const fields = candidate.meta?.target;
  if (Array.isArray(fields)) return fields.includes(target);
  return typeof fields === "string" && fields.includes(target);
}

export const checkUser = async () => {
  const user = await currentUser();
  if (!user) return null;

  const email = user.emailAddresses[0]?.emailAddress;
  if (!email) {
    console.error("[checkUser] Clerk user has no email address:", user.id);
    return null;
  }

  const profile = {
    name: `${user.firstName ?? ""} ${user.lastName ?? ""}`.trim(),
    email,
    imageUrl: user.imageUrl ?? "",
  };

  try {
    const currentPlan = await getCurrentPlan();

    // Upsert rather than find-then-create: Header runs on every request, so two
    // concurrent first-requests from a new user would both reach create and one
    // would fail on the clerkId unique constraint.
    let existing;
    try {
      existing = await db.user.upsert({
        where: { clerkId: user.id },
        update: {},
        create: {
          clerkId: user.id,
          ...profile,
          credits: PLANS.free.credits,
          plan: "free",
        },
      });
    } catch (error) {
      // A different Clerk account already owns this email. Clerk instances issue
      // new user ids (notably when migrating development -> production), so the
      // row exists but is keyed to the old id. Re-key it to the current one
      // instead of leaving the user with no account at all.
      if (!isUniqueConstraintError(error, "email")) throw error;

      existing = await db.user.update({
        where: { email },
        data: { clerkId: user.id, ...profile },
      });
    }

    if (existing.plan === currentPlan) return existing;

    // Only top up credits on upgrade (positive delta), not on downgrade
    const existingPlanCredits = PLANS[existing.plan as Plan]?.credits ?? 0;
    const newPlanCredits = PLANS[currentPlan].credits;
    const creditDelta = newPlanCredits - existingPlanCredits;

    // Guard on the old plan so concurrent requests cannot double-credit
    const { count } = await db.user.updateMany({
      where: { clerkId: user.id, plan: existing.plan },
      data: {
        plan: currentPlan,
        credits:
          creditDelta > 0 ? existing.credits + creditDelta : existing.credits,
      },
    });

    if (count === 0) return existing;

    return await db.user.findUnique({ where: { clerkId: user.id } });
  } catch (error) {
    // Returning null here renders the app as though the user were signed out,
    // which is indistinguishable from a real logout. Keep it loud in the logs
    // until an error tracker is wired up.
    console.error("[checkUser] failed to sync user", user.id, error);
    return null;
  }
};

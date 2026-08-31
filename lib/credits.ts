import { db } from "./prisma";
import { CREDIT_COST_PER_GENERATION } from "./constants";

/**
 * Deducts a credit only if the balance can cover it, in a single conditional
 * UPDATE. Read-then-write cannot be used here: concurrent requests would both
 * pass the check and drive the balance negative.
 *
 * Returns false when the user had insufficient credits and nothing was charged.
 */
export async function reserveCredit(userId: string): Promise<boolean> {
  const { count } = await db.user.updateMany({
    where: { id: userId, credits: { gte: CREDIT_COST_PER_GENERATION } },
    data: { credits: { decrement: CREDIT_COST_PER_GENERATION } },
  });
  return count === 1;
}

/** Returns a reserved credit after a failed or aborted run. */
export async function refundCredit(userId: string): Promise<void> {
  await db.user.update({
    where: { id: userId },
    data: { credits: { increment: CREDIT_COST_PER_GENERATION } },
  });
}

export async function getCredits(userId: string): Promise<number> {
  const user = await db.user.findUnique({
    where: { id: userId },
    select: { credits: true },
  });
  return user?.credits ?? 0;
}

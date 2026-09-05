"use server";

import { checkUser } from "@/lib/checkUser";
import { db } from "@/lib/prisma";
import type { Plan } from "@/types/plans";
import { auth } from "@clerk/nextjs/server";

export async function getUserCredits(): Promise<{ credits: number; plan: Plan } | null> {
  const { userId: clerkId } = await auth();
  if (!clerkId) return null;

  let user = await db.user.findUnique({
    where: { clerkId },
    select: { credits: true, plan: true },
  });

  if (!user) {
    const synced = await checkUser();
    if (synced) {
      user = { credits: synced.credits, plan: synced.plan };
    }
  }

  if (!user) return null;

  return {
    credits: user.credits,
    plan: user.plan as Plan,
  };
}

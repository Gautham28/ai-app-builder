"use client";

import React from "react";
import { Check, Sparkles, Zap } from "lucide-react";
import { Button } from "@/components/ui/button";
import { PRICING_PLANS } from "@/lib/constants";
import { SignInButton, useUser } from "@clerk/nextjs";
import { toast } from "sonner";
import { cn } from "@/lib/utils";
import type { Plan } from "@/types/plans";

interface PricingCardsProps {
  currentPlan?: Plan | null;
  onSelectPlan?: (planKey: string) => void;
  className?: string;
}

export default function PricingCards({
  currentPlan = "free",
  onSelectPlan,
  className,
}: PricingCardsProps) {
  const { isSignedIn } = useUser();

  const handlePlanClick = (planKey: string) => {
    if (onSelectPlan) {
      onSelectPlan(planKey);
      return;
    }

    if (planKey === "free") {
      toast.info("You are already on the Free tier with 10 free credits.");
      return;
    }

    // Placeholder for Dodo Payments / Lemon Squeezy integration
    toast.success(
      `Selected ${planKey.toUpperCase()} plan! Payment gateway integration coming soon.`
    );
  };

  return (
    <div
      className={cn(
        "grid grid-cols-1 md:grid-cols-3 gap-6 lg:gap-8 w-full max-w-6xl mx-auto",
        className
      )}
    >
      {PRICING_PLANS.map((plan) => {
        const isCurrent = isSignedIn && currentPlan === plan.key;
        const isFeatured = plan.featured;

        return (
          <div
            key={plan.key}
            className={cn(
              "relative flex flex-col rounded-2xl border p-7 transition-all duration-300",
              isFeatured
                ? "border-violet-500/60 bg-gradient-to-b from-violet-950/30 via-[#111116] to-[#0d0d10] shadow-2xl shadow-violet-950/40 ring-1 ring-violet-500/40"
                : "border-white/10 bg-[#111114]/80 hover:border-white/20 hover:bg-[#151518]"
            )}
          >
            {/* Featured Badge */}
            {isFeatured && (
              <div className="absolute -top-3.5 left-1/2 -translate-x-1/2">
                <span className="inline-flex items-center gap-1.5 rounded-full bg-gradient-to-r from-violet-600 to-indigo-600 px-3 py-1 text-xs font-semibold text-white shadow-md shadow-violet-500/30">
                  <Sparkles className="h-3 w-3" />
                  Most Popular
                </span>
              </div>
            )}

            {/* Plan Header */}
            <div className="mb-6">
              <div className="flex items-center justify-between">
                <h3 className="text-xl font-bold text-white">{plan.label}</h3>
                {isCurrent && (
                  <span className="rounded-full border border-violet-400/30 bg-violet-500/10 px-2.5 py-0.5 text-[11px] font-medium text-violet-300">
                    Current Plan
                  </span>
                )}
              </div>
              <p className="mt-2 text-xs text-white/50 min-h-[32px]">
                {plan.description}
              </p>
            </div>

            {/* Price */}
            <div className="mb-6 flex items-baseline gap-1">
              <span className="text-4xl font-extrabold text-white">
                ${plan.price}
              </span>
              <span className="text-xs text-white/40">
                {plan.price === 0 ? "forever" : "/ month"}
              </span>
            </div>

            {/* Features List */}
            <div className="mb-8 flex-1 space-y-3 border-t border-white/8 pt-6">
              {plan.features.map((feature, idx) => (
                <div key={idx} className="flex items-center gap-2.5 text-xs text-white/80">
                  <div
                    className={cn(
                      "flex h-4 w-4 shrink-0 items-center justify-center rounded-full",
                      isFeatured
                        ? "bg-violet-500/20 text-violet-400"
                        : "bg-white/10 text-white/70"
                    )}
                  >
                    <Check className="h-2.5 w-2.5" />
                  </div>
                  <span>{feature}</span>
                </div>
              ))}
            </div>

            {/* CTA Button */}
            {!isSignedIn ? (
              <SignInButton mode="modal">
                <Button
                  className={cn(
                    "w-full h-10 rounded-xl font-semibold text-xs cursor-pointer transition-all active:scale-[0.98]",
                    isFeatured
                      ? "bg-violet-600 hover:bg-violet-500 text-white shadow-lg shadow-violet-600/30"
                      : "bg-white/10 hover:bg-white/20 text-white"
                  )}
                >
                  <Zap className="h-3.5 w-3.5 mr-1.5" />
                  Get Started Free
                </Button>
              </SignInButton>
            ) : (
              <Button
                disabled={isCurrent}
                onClick={() => handlePlanClick(plan.key)}
                className={cn(
                  "w-full h-10 rounded-xl font-semibold text-xs cursor-pointer transition-all active:scale-[0.98]",
                  isCurrent
                    ? "bg-white/5 text-white/30 border border-white/10 cursor-not-allowed"
                    : isFeatured
                    ? "bg-violet-600 hover:bg-violet-500 text-white shadow-lg shadow-violet-600/30"
                    : "bg-white/10 hover:bg-white/20 text-white"
                )}
              >
                {isCurrent
                  ? "Current Plan"
                  : plan.price === 0
                  ? "Free Plan"
                  : `Upgrade to ${plan.label}`}
              </Button>
            )}
          </div>
        );
      })}
    </div>
  );
}

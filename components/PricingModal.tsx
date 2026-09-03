import React from "react";
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle, DialogTrigger } from "./ui/dialog";
import { BlueTitle } from "./reusables";
import PricingCards from "./PricingCards";

interface PricingModalProps {
    children: React.ReactNode;
    reason?: "credits" | "upgrade" ;
}

const PricingModal = ({ children, reason = "upgrade"} : PricingModalProps ) => {
    const title =
        reason === "credits" ? "You're out of credits" : "Upgrade your plan" ;
    const description =
        reason === "credits"
        ? "You've used all your credits. Upgrade to keep building."
        : "Choose a plan that fits how much you build.";

        return (
        <Dialog>
        <DialogTrigger className="cursor-pointer">{children}</DialogTrigger>
        <DialogContent 
        className={
            "border-white/10 bg-[#0c0c0e] p-0 text-white sm:max-w-5xl max-h-[90dvh] overflow-y-auto"
        }>
          <DialogHeader className="px-6 pt-6 pb-2 text-center">
            <DialogTitle className="font-serif text-xl tracking-tight text-white/90">
            <BlueTitle className="text-3xl sm:text-4xl">{title}</BlueTitle>
            </DialogTitle>
            <DialogDescription className="text-sm text-white/40 mt-1">
              {description}
            </DialogDescription>
          </DialogHeader>
            <div className="p-6">
                <PricingCards />
            </div>
        </DialogContent>
      </Dialog>
        );
};

export default PricingModal;
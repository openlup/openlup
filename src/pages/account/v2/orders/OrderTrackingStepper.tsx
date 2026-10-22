import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { CUSTOMER_STEP_SEQUENCE } from "@/domains/fulfillment/statusMap";

import type { FulfillmentProgressPresentation } from "@openlup/platform/fulfillment/contracts";

const STEPS = CUSTOMER_STEP_SEQUENCE;

/** Canonical milestones, checked only when existing record evidence supports them. */
export function OrderTrackingStepper({ progress }: { progress: FulfillmentProgressPresentation }) {
  const { t } = useTranslation("account");
  return (
    <div className="relative">
      <div className="absolute left-4 right-4 top-3 h-px bg-teal-dark/12" aria-hidden />
      <ol className="relative flex justify-between">
        {STEPS.map((step) => {
          const done = progress.completedSteps.includes(step);
          const current = step === progress.currentStep;
          // State labels are announced to AT only; visual state stays color-driven.
          const stateLabel = current ? "w toku" : done ? "ukończone" : "oczekuje";
          return (
            <li
              key={step}
              data-step={step}
              data-complete={done}
              aria-current={current ? "step" : undefined}
              className="flex flex-1 flex-col items-center gap-2 text-center"
            >
              <span
                className={cn(
                  "grid h-6 w-6 place-items-center rounded-full border-2",
                  done
                    ? "border-teal bg-teal text-white"
                    : "border-teal-dark/20 bg-card text-transparent",
                )}
              >
                <Check size={12} />
              </span>
              <span
                className={cn(
                  "text-xxs font-semibold",
                  done ? "text-foreground" : "text-foreground/45",
                )}
              >
                {t(`account:dashboard.ordersV2.steps.${step}`)}
                <span className="sr-only"> – {stateLabel}</span>
              </span>
            </li>
          );
        })}
      </ol>
    </div>
  );
}

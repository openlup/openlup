import { useTranslation } from "react-i18next";
import { Check } from "lucide-react";
import { cn } from "@/lib/utils";
import { CUSTOMER_STEP_SEQUENCE } from "@/domains/fulfillment/statusMap";

const STEPS = CUSTOMER_STEP_SEQUENCE;

/**
 * 5-phase fulfillment stepper (Opłacone → Przyjęte → Przygotowanie → W drodze →
 * Dostarczone). `phaseIndex` is derived from the order's real fulfilment/tracking
 * state (config/fulfillment-status-map.json) — steps up to and including it are
 * marked done, no fabricated progress. Labels come from `ordersV2.steps.*`.
 */
export function OrderTrackingStepper({ phaseIndex }: { phaseIndex: number }) {
  const { t } = useTranslation("account");
  return (
    <div className="relative">
      <div className="absolute left-4 right-4 top-3 h-px bg-teal-dark/12" aria-hidden />
      <ol className="relative flex justify-between">
        {STEPS.map((step, index) => {
          const done = index <= phaseIndex;
          const current = index === phaseIndex;
          // State labels are announced to AT only; visual state stays color-driven.
          const stateLabel = current ? "w toku" : index < phaseIndex ? "ukończone" : "oczekuje";
          return (
            <li
              key={step}
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

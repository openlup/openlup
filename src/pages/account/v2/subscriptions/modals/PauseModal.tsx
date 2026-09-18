import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { Pause } from "lucide-react";

import type { CustomerSubscriptionActionRequest } from "@/domains/customers/selfServiceContracts";
import { cn } from "@/lib/utils";
import { idempotencyKey } from "../../../DashboardPanelUtils";
import type { Subscription } from "../../lib/subscriptionEditModel";
import { CoralButton, GhostButton } from "../../ui/atoms";
import { ManageDialog } from "./ManageDialog";

type PauseDuration = "2_weeks" | "1_month" | "indefinite";
const PAUSE_DURATIONS: PauseDuration[] = ["2_weeks", "1_month", "indefinite"];
const DEFAULT_PAUSE_DURATION: PauseDuration = "2_weeks";

export function PauseModal({
  subscription,
  open,
  onOpenChange,
  onAction,
}: {
  subscription: Subscription;
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAction: (body: CustomerSubscriptionActionRequest) => Promise<unknown> | void;
}) {
  const { t } = useTranslation("account");
  const tr = (key: string) => t(`account:dashboard.panels.subscriptions.pauseModal.${key}`);
  const [duration, setDuration] = useState<PauseDuration>(DEFAULT_PAUSE_DURATION);

  // Reset the choice on each open: the modal stays mounted across opens, so a
  // previous session's selection would otherwise be preselected.
  useEffect(() => {
    if (!open) return;
    setDuration(DEFAULT_PAUSE_DURATION);
  }, [open]);

  function confirm() {
    onOpenChange(false);
    void onAction({
      action: "pause",
      idempotencyKey: idempotencyKey("pause"),
      subscriptionId: subscription.subscriptionId,
      pausePreset: duration,
      reason: `pause_duration=${duration}`,
    });
  }

  return (
    <ManageDialog
      open={open}
      onOpenChange={onOpenChange}
      title={tr("title")}
      description={tr("description")}
      footer={
        <>
          <GhostButton onClick={() => onOpenChange(false)}>
            {t("account:dashboard.workspace.cancel")}
          </GhostButton>
          <CoralButton icon={<Pause size={16} />} onClick={confirm}>
            {t("account:dashboard.subscriptionV2.lifecycle.pause")}
          </CoralButton>
        </>
      }
    >
      <fieldset className="space-y-2.5">
        <legend className="sr-only">{tr("legend")}</legend>
        {PAUSE_DURATIONS.map((value) => {
          const active = duration === value;
          return (
            <label
              key={value}
              className={cn(
                "flex cursor-pointer items-center gap-3 rounded-control border px-4 py-3 text-sm transition-colors",
                active ? "border-teal bg-teal/10" : "border-teal-dark/10 hover:border-teal",
              )}
            >
              <input
                type="radio"
                name={`v2-pause-${subscription.subscriptionId}`}
                value={value}
                checked={active}
                onChange={() => setDuration(value)}
                className="size-4 accent-teal"
              />
              <span className="font-semibold text-foreground">{tr(`durations.${value}`)}</span>
            </label>
          );
        })}
      </fieldset>
    </ManageDialog>
  );
}

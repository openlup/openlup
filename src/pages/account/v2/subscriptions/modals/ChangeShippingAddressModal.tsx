import { useEffect, useState } from "react";
import { useTranslation } from "react-i18next";
import { ArrowRight, MapPin } from "lucide-react";

import type { CustomerAccountV2Response } from "@/domains/customers/accountV2Contracts";
import type { CustomerSubscriptionActionRequest } from "@/domains/customers/selfServiceContracts";
import { cn } from "@/lib/utils";
import { idempotencyKey } from "../../../DashboardPanelUtils";
import type { Subscription } from "../../lib/subscriptionEditModel";
import { CoralButton } from "../../ui/atoms";
import { ManageDialog } from "./ManageDialog";

type Address = CustomerAccountV2Response["addresses"][number];

export function ChangeShippingAddressModal({
  subscription,
  addresses,
  open,
  onOpenChange,
  onAction,
}: {
  subscription: Subscription;
  addresses: Address[];
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onAction: (body: CustomerSubscriptionActionRequest) => Promise<unknown> | void;
}) {
  const { t } = useTranslation("account");
  const [selected, setSelected] = useState<string | null>(subscription.shippingAddressId);

  // Re-seed from the subscription on each open. The mount-time seed alone went
  // stale after a successful change: the modal stays mounted, so reopening kept
  // showing the previously selected address instead of the saved one. `open` is
  // deliberately the only dependency — reacting to the subscription value would
  // overwrite an in-progress selection on any background account refetch.
  useEffect(() => {
    if (!open) return;
    setSelected(subscription.shippingAddressId);
  }, [open]);

  function confirm() {
    if (!selected) return;
    onOpenChange(false);
    void onAction({
      action: "change_shipping_address",
      idempotencyKey: idempotencyKey("change-address"),
      subscriptionId: subscription.subscriptionId,
      shippingAddressId: selected,
    });
  }

  return (
    <ManageDialog
      open={open}
      onOpenChange={onOpenChange}
      title={t("account:dashboard.subscriptionV2.changeAddress.title")}
      description={t("account:dashboard.subscriptionV2.changeAddress.description")}
      footer={
        <CoralButton icon={<ArrowRight size={16} />} onClick={confirm} disabled={!selected}>
          {t("account:dashboard.subscriptionV2.changeAddress.confirm")}
        </CoralButton>
      }
    >
      {addresses.length === 0 ? (
        <p className="text-sm text-foreground/60">
          {t("account:dashboard.subscriptionV2.changeAddress.empty")}
        </p>
      ) : (
        <div className="space-y-2.5">
          {addresses.map((address) => {
            const active = address.addressId === selected;
            return (
              <button
                key={address.addressId}
                type="button"
                onClick={() => setSelected(address.addressId)}
                aria-pressed={active}
                className={cn(
                  "focus-ring flex w-full items-start gap-3 rounded-control border px-4 py-3 text-left transition-colors",
                  active ? "border-teal bg-teal/10" : "border-teal-dark/10 hover:border-teal",
                )}
              >
                <MapPin size={17} className="mt-0.5 shrink-0 text-teal" />
                <span className="text-sm">
                  <span className="block font-semibold text-foreground">
                    {address.label ?? address.city}
                  </span>
                  <span className="text-foreground/65">
                    {[address.line1, address.postalCode, address.city].filter(Boolean).join(", ")}
                  </span>
                </span>
              </button>
            );
          })}
        </div>
      )}
    </ManageDialog>
  );
}

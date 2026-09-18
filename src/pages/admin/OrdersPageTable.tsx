import { AlertTriangle, CheckCircle2, CreditCard, PackageCheck, Truck } from "lucide-react";
import { useTranslation } from "react-i18next";
import { TableCell, TableRow } from "@/components/ui/table";
import type { AdminOmsOrderListItem } from "@/domains/commerce/omsContracts";
import { AdminStatusPill } from "@/components/admin/AdminSurface";
import { cn } from "@/lib/utils";
import { customerName, formatDate, formatMoney, formatOperatorOrderRef, operatorPipelineStages } from "./ordersPageUtils";
import { stepLabelKey, stepUsesTruckIcon } from "@/domains/fulfillment/statusMap";

export function OrderRow({
  order,
  locale,
  selected,
  onSelect,
}: {
  order: AdminOmsOrderListItem;
  locale: string;
  selected: boolean;
  onSelect: () => void;
}) {
  const { t } = useTranslation("admin");
  const orderRef = formatOperatorOrderRef(order.orderNumber, order.orderId);
  return (
    <TableRow
      data-testid="admin-oms-order-row"
      data-order-id={order.orderId}
      data-order-number={orderRef}
      tabIndex={0}
      aria-label={orderRef}
      aria-selected={selected}
      onClick={onSelect}
      onKeyDown={(event) => {
        if (event.key !== "Enter" && event.key !== " ") return;
        event.preventDefault();
        onSelect();
      }}
      className={cn(
        "cursor-pointer border-warm-sand focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-teal/70",
        selected ? "bg-light-teal/70" : "hover:bg-offwhite",
      )}
    >
      <TableCell>
        <p className="font-display text-sm font-semibold text-teal-dark">{orderRef}</p>
        <p className="text-xs text-text-muted">{formatDate(order.createdAt, locale)}</p>
        {order.match && (
          <p className="mt-1 max-w-60 truncate text-xxs font-semibold text-teal">
            {t("admin:adminOms.search.matched", {
              field: t(`admin:adminOms.search.field.${order.match.field}`),
              value: order.match.valuePreview ?? order.match.label,
            })}
          </p>
        )}
        <AdminStatusPill className="mt-1" tone="neutral">{t(`admin:adminOms.mode.${order.mode}`)}</AdminStatusPill>
      </TableCell>
      <TableCell>
        <p className="font-semibold text-teal-dark">{customerName(order)}</p>
        <p className="text-xs text-text-muted">{order.customer?.email ?? t("admin:adminOms.missing.customer")}</p>
        {order.pet && <p className="text-xs font-semibold text-teal">{order.pet.name ?? t("admin:adminOms.missing.pet")}</p>}
      </TableCell>
      <TableCell>
        <MiniPipeline order={order} />
      </TableCell>
      <TableCell>
        <div className="grid gap-1">
          <AdminStatusPill tone={order.paymentStatus === "succeeded" ? "good" : order.paymentStatus === "failed" ? "bad" : "warn"}>
            <CreditCard size={12} aria-hidden="true" />
            {t(`admin:adminOms.paymentStatus.${order.paymentStatus}`)}
          </AdminStatusPill>
          <span className="text-xxs font-semibold uppercase text-text-muted">
            {order.paymentMethodLabel ?? t("admin:adminOms.detail.notAvailable")}
          </span>
        </div>
      </TableCell>
      <TableCell>
        <div className="flex items-center gap-2 text-sm">
          {order.attentionReason === "none" ? (
            <CheckCircle2 className="text-teal" size={16} />
          ) : (
            <AlertTriangle className="text-warm-amber" size={16} />
          )}
          <div>
            <p className="font-semibold text-teal-dark">{t(`admin:adminOms.attention.${order.attentionReason}`)}</p>
            <p className="text-xs font-semibold text-teal">{t(`admin:adminOms.nextAction.${order.nextAction}`)}</p>
            <AttentionCause order={order} />
          </div>
        </div>
      </TableCell>
      <TableCell>
        <p className="font-display text-sm font-semibold text-teal-dark">{formatMoney(order.total, locale)}</p>
        <p className="text-xxs text-text-muted">{formatDate(order.updatedAt, locale)}</p>
      </TableCell>
    </TableRow>
  );
}

/**
 * The line under the attention label that says *why*. `attentionReason` stops at
 * `active_hold`; the hold's own reason and the fulfillment-health digest are what
 * an operator had to open the detail view to read. Both are silent when there is
 * nothing to say, so a healthy queue looks exactly as it did before.
 */
function AttentionCause({ order }: { order: AdminOmsOrderListItem }) {
  const { t } = useTranslation("admin");
  const { healthStatus, attentionReasons } = order.fulfillmentHealthDigest;
  const showHealth = healthStatus !== "ok";
  if (!order.activeHoldReasons.length && !showHealth) return null;
  return (
    <div className="mt-1 grid max-w-52 gap-0.5">
      {order.activeHoldReasons.length > 0 && (
        <p className="text-xxs font-semibold text-warm-coral" data-testid="admin-oms-hold-reasons">
          {order.activeHoldReasons.map((reason) => t(`admin:adminOms.holdReason.${reason}`)).join(" · ")}
        </p>
      )}
      {showHealth && (
        <p className="text-xxs font-semibold text-text-muted" data-testid="admin-oms-health-digest">
          {t(`admin:adminOms.fulfillmentHealth.${healthStatus}`)}
          {attentionReasons.length > 0 &&
            `: ${attentionReasons.map((reason) => t(`admin:adminOms.fulfillmentHealthReason.${reason}`)).join(", ")}`}
        </p>
      )}
    </div>
  );
}

function MiniPipeline({ order }: { order: AdminOmsOrderListItem }) {
  const { t } = useTranslation("admin");
  const customerStep = order.customerFulfillmentStep;
  const stages = operatorPipelineStages(order);
  const label =
    order.paymentStatus !== "succeeded"
      ? "admin:adminOms.pipeline.payment"
      : order.inventoryStatus !== "reserved" && order.inventoryStatus !== "consumed"
        ? "admin:adminOms.pipeline.inventory"
        : stepLabelKey(customerStep);

  return (
    <div className="min-w-52">
      <div className="flex items-center gap-1">
        {stages.map((stage) => (
          <span
            key={stage.key}
            className={cn(
              "h-1.5 w-10 rounded-full",
              stage.blocked
                ? "bg-warm-coral"
                : stage.complete
                  ? "bg-teal"
                  : stage.active
                    ? "bg-warm-amber"
                    : "bg-warm-sand",
            )}
          />
        ))}
      </div>
      <div className="mt-2 flex items-center gap-1.5 text-xs font-semibold text-text-muted">
        {order.paymentStatus !== "succeeded" ? <CreditCard size={13} /> : stepUsesTruckIcon(customerStep) ? <Truck size={13} /> : <PackageCheck size={13} />}
        <span>{t(label)}</span>
      </div>
      {order.providerOpsStatus !== "none" ? (
        <div className="mt-2 flex flex-wrap items-center gap-1.5">
          <AdminStatusPill tone={providerOpsTone(order.providerOpsSla?.status)}>
            {t(`admin:adminOms.providerOpsStatus.${order.providerOpsStatus}`)}
          </AdminStatusPill>
          {order.providerOpsSla ? (
            <span className="text-xxs font-semibold text-text-muted">
              {t(`admin:adminOms.providerOpsSla.${order.providerOpsSla.status}`)}
            </span>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function providerOpsTone(status: NonNullable<AdminOmsOrderListItem["providerOpsSla"]>["status"] | undefined) {
  if (status === "breached") return "bad" as const;
  if (status === "watch" || status === "paused_non_shipping_day") return "warn" as const;
  return "neutral" as const;
}

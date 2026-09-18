import type { TFunction } from "i18next";
import { AdminPanel } from "@/components/admin/AdminSurface";
import type { AdminCommerceOrdersListResponse } from "@/domains/commerce/omsContracts";
import { customerName, formatDate, formatOperatorOrderRef } from "./ordersPageUtils";

export function RecentOrdersPanel({
  orders,
  loading,
  error,
  t,
  locale,
}: {
  orders: AdminCommerceOrdersListResponse["orders"];
  loading: boolean;
  error: boolean;
  t: TFunction;
  locale: string;
}) {
  return (
    <AdminPanel className="p-5">
      <p className="label-text text-text-muted">{t("admin:adminDashboard.recent.title")}</p>
      <div className="mt-4 space-y-3">
        {loading ? (
          <p className="text-sm text-text-muted">{t("admin:adminDashboard.recent.loading")}</p>
        ) : error ? (
          <p className="text-sm text-warm-coral">{t("admin:adminDashboard.recent.error")}</p>
        ) : orders.length === 0 ? (
          <p className="text-sm text-text-muted">{t("admin:adminDashboard.recent.empty")}</p>
        ) : (
          orders.slice(0, 6).map((order) => (
            <div key={order.orderId} className="flex items-start gap-3">
              <span className="mt-1 h-2 w-2 rounded-full bg-teal" />
              <div>
                <p className="text-sm font-semibold text-teal-dark">
                  {order.nextAction === "none" ? t(`admin:adminOms.orderStatus.${order.status}`) : t(`admin:adminOms.nextAction.${order.nextAction}`)}
                </p>
                <p className="text-xs text-text-muted">{formatOperatorOrderRef(order.orderNumber, order.orderId)} · {customerName(order)} · {formatDate(order.updatedAt, locale)}</p>
              </div>
            </div>
          ))
        )}
      </div>
    </AdminPanel>
  );
}

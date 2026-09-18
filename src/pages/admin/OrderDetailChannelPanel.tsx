import { useQuery } from "@tanstack/react-query";
import type { TFunction } from "i18next";

import { AdminStatusPill } from "@/components/admin/AdminSurface";
import {
  channelIngestNeedsAttention,
  getAdminChannelOrderOps,
} from "@/domains/channels/channelOpsClient";
import { DetailSection } from "./OrderDetailBlocks";

/**
 * The second life story of a channel-sourced order: where its ingest run got to, and how deep the
 * operator queue is on the surface it came from.
 *
 * IT RENDERS NOTHING FOR A STOREFRONT ORDER, and that is the design rather than an omission. Most
 * orders in this panel came from the shop's own checkout and have no ingest run to report; a
 * section that appeared for them saying "not applicable" would be noise on every order to be
 * useful on a few. The read answers `channel: null` for those and this returns null.
 *
 * IT SELF-FETCHES, following the accounting panel next to it, so the OMS detail read does not have
 * to grow a channels-shaped field for a minority of orders and every other order does not pay for
 * a join it will never use.
 *
 * A FAILED READ IS SAID OUT LOUD, not swallowed. This panel exists for the moments something has
 * gone wrong upstream, so a silent empty section here would be the worst possible behaviour: it
 * would look exactly like a healthy storefront order.
 *
 * A SWITCHED-OFF FEATURE IS NOT A FAILED READ, and the loud box is reserved for the second. While
 * this deployment runs no connector the route refuses every call fail-closed; that is a decision it
 * made, not something that went wrong, and painting an alarm on every order detail for it teaches
 * operators to read the alarm as furniture — which is exactly how the real one gets missed. The
 * client hands that refusal over as `kind: "disabled"` and this renders nothing, the same silence a
 * storefront order gets. Every other refusal still throws and still shows the box.
 */
export function OrderDetailChannelPanel({
  accessToken,
  orderId,
  t,
}: {
  accessToken: string | undefined;
  orderId: string;
  t: TFunction;
}) {
  const ops = useQuery({
    queryKey: ["admin-channel-order-ops", orderId, accessToken],
    enabled: Boolean(orderId && accessToken),
    retry: false,
    queryFn: async () => {
      if (!accessToken) throw new Error("Admin session required");
      return getAdminChannelOrderOps(accessToken, orderId);
    },
  });

  if (ops.isLoading) return null;

  if (ops.isError) {
    return (
      <DetailSection
        title={t("admin:adminOms.channel.title")}
        className="border-warm-amber/40 bg-warm-amber/10"
      >
        <p className="text-sm text-warm-amber">{t("admin:adminOms.channel.error")}</p>
      </DetailSection>
    );
  }

  if (ops.data?.kind !== "ok") return null;

  const data = ops.data.data;
  if (!data.channel) return null;

  const attention = channelIngestNeedsAttention(data.ingest?.status);

  return (
    <DetailSection title={t("admin:adminOms.channel.title")}>
      <dl className="grid gap-3 sm:grid-cols-2">
        <div>
          <dt className="text-xs text-text-muted">{t("admin:adminOms.channel.surface")}</dt>
          <dd className="text-sm">
            {data.channel.displayName}{" "}
            <span className="font-mono text-xs text-text-muted">({data.channel.slug})</span>
          </dd>
        </div>
        <div>
          <dt className="text-xs text-text-muted">{t("admin:adminOms.channel.ingestStatus")}</dt>
          <dd className="text-sm">
            {data.ingest === null ? (
              <span className="text-text-muted">{t("admin:adminOms.channel.noLedger")}</span>
            ) : (
              <AdminStatusPill tone={attention ? "warn" : "teal"}>
                {data.ingest.status}
              </AdminStatusPill>
            )}
          </dd>
        </div>

        {data.ingest === null ? null : (
          <>
            <div>
              <dt className="text-xs text-text-muted">{t("admin:adminOms.channel.externalRef")}</dt>
              <dd className="font-mono text-xs">
                {data.ingest.externalOrderRef}
                {data.ingest.externalOrderRevision === null
                  ? null
                  : ` @ ${data.ingest.externalOrderRevision}`}
              </dd>
            </div>
            <div>
              <dt className="text-xs text-text-muted">{t("admin:adminOms.channel.queue")}</dt>
              <dd className="text-sm">
                {data.openQuarantineCount === 0 ? (
                  <span className="text-text-muted">{t("admin:adminOms.channel.queueEmpty")}</span>
                ) : (
                  <span className="font-semibold text-warm-amber">
                    {t("admin:adminOms.channel.queueOpen", { count: data.openQuarantineCount })}
                  </span>
                )}
              </dd>
            </div>
          </>
        )}
      </dl>

      {data.ingest?.lastError ? (
        <p className="mt-3 rounded bg-warm-amber/10 p-2 font-mono text-xs text-warm-amber">
          {data.ingest.lastError}
        </p>
      ) : null}
    </DetailSection>
  );
}

import { useState, type ReactNode } from "react";
import type { AccountSnapshot, AccountOrderSummary } from "@openlup/platform/account-support/contracts";

export interface AccountSupportAccountStrings {
  title: string;
  loading: string;
  error: string;
  unavailable: string;
  unknown: string;
  refresh: string;
  subscriptions: string;
  nextCycle: string;
  nextCharge: string;
  addresses: string;
  billing: string;
  preferences: string;
  orders: string;
  expand: string;
  documents: string;
  download: string;
  tracking: string;
  profile: string;
}

export interface AccountSupportAccountProps<Extension> {
  data: AccountSnapshot<Extension> | null;
  loading?: boolean;
  error?: string | null;
  strings: AccountSupportAccountStrings;
  onRefresh(): void;
  renderExtension?(value: Extension): ReactNode;
  onDownload?(order: AccountOrderSummary, documentKey: string): void;
}

/** Unmounted host-fed read view. Refresh can retain last-known data; expansion uses only the summary. */
export function AccountSupportAccount<Extension>({
  data,
  loading,
  error,
  strings: s,
  onRefresh,
  renderExtension,
  onDownload
}: AccountSupportAccountProps<Extension>) {
  const [selected, select] = useState<string | null>(null);
  const subscription = data?.subscriptions.find(value => value.subscriptionId === selected) ?? data?.subscriptions[0];
  const money = (value: { amountMinor: number; currency: string } | null | undefined) => value
    ? `${value.amountMinor} ${value.currency}`
    : s.unknown;
  return <section aria-label={s.title}>
    <h1>{s.title}</h1>
    <button type="button" onClick={onRefresh}>{s.refresh}</button>
    {loading && <p role="status">{s.loading}</p>}
    {error && <p role="alert">{s.error}: {error}</p>}
    {!data ? <p>{s.unavailable}</p> : <>
      <h2>{s.profile}</h2>
      <p>{data.profile.email}</p>
      <p>{data.profile.firstName ?? s.unknown} {data.profile.lastName ?? s.unknown}</p>
      <p>{data.profile.phone ?? s.unknown}</p>
      {renderExtension?.(data.extension)}
      <h2>{s.subscriptions}</h2>
      <select
        aria-label={s.subscriptions}
        value={subscription?.subscriptionId ?? ""}
        onChange={event => select(event.target.value)}
      >
        {data.subscriptions.map(value =>
          <option key={value.subscriptionId} value={value.subscriptionId}>{value.subscriptionId}</option>
        )}
      </select>
      {subscription && <article>
        <p>{subscription.status}</p>
        <p>{subscription.cadenceDays}</p>
        <p>{s.nextCycle}: {subscription.nextCycleAt ?? s.unknown}</p>
        <p>{s.nextCharge}: {money(subscription.nextCharge?.totalGross)}</p>
        <p>{
          subscription.deliveryAlignment?.state ?? s.unknown
        }</p>
        <p>{subscription.packageSummary ?? s.unknown}</p>
        {subscription.lines.map(line =>
          <p key={line.lineId}>{line.displayLabel ?? line.title ?? s.unknown}: {line.qty} — {money(line.lineSubtotal)}</p>
        )}
      </article>}
      <h2>{s.addresses}</h2>
      {data.addresses.map(value =>
        <p key={value.addressId}>{value.recipientName ?? s.unknown}: {value.line1}, {value.postalCode} {value.city}, {value.country}</p>
      )}
      <h2>{s.billing}</h2>
      {data.billingProfiles.map(value =>
        <p key={value.profileId}>{value.fullName}: {value.companyName ?? s.unknown}, {value.taxId ?? s.unknown}</p>
      )}
      <h2>{s.preferences}</h2>
      {data.paymentPreferences.map((value, i) =>
        <p key={`payment-${i}`}>{value.scope}: {value.methodKind}</p>
      )}
      {data.deliveryPreferences.map((value, i) =>
        <p key={`delivery-${i}`}>{value.scope}: {value.deliveryKind}, {value.pickupPoint?.name ?? value.carrierKind}</p>
      )}
      <h2>{s.orders}</h2>
      {data.recentOrders.map(order =>
        <article key={order.orderId}>
          <p>{order.orderNumber ?? order.orderId}: {order.status}, {money(order.total)}</p>
          <details>
            <summary>{s.expand}</summary>
            <p>{order.customerFulfillmentStep ?? s.unknown}</p>
            <p>{s.tracking}: {order.trackingNumber ?? s.unknown}</p>
            {order.trackingReferences.map((reference, i) =>
              <p key={i}>
                {reference.trackingUrl ? <a href={reference.trackingUrl}>{reference.trackingNumber}</a> : reference.trackingNumber}
              </p>
            )}
            {order.trackingTimeline.map((event, i) => <p key={i}>{event.label}: {event.occurredAt ?? s.unknown}</p>)}
            <h3>{s.documents}</h3>
            {order.invoiceDocuments.map(document =>
              <p key={document.documentKey}>
                {document.role}: {document.documentDeliveryStatus}
                {document.downloadAvailable && onDownload && <button
                  type="button"
                  onClick={() => onDownload(order, document.documentKey)}
                >{s.download}</button>}
              </p>
            )}
          </details>
        </article>
      )}
    </>}
  </section>;
}

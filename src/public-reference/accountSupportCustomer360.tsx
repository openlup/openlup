import { useState, type ReactNode } from "react";
import type { Customer360Snapshot, Customer360SearchResponse } from "@openlup/platform/account-support/contracts";

export interface AccountSupportCustomer360Strings {
  title: string;
  query: string;
  search: string;
  refresh: string;
  loading: string;
  denied: string;
  unavailable: string;
  noMatches: string;
  unknown: string;
  partial: string;
  orders: string;
  subscriptions: string;
  payment: string;
  recovery: string;
  audit: string;
  contact: string;
  addresses: string;
}

export interface AccountSupportCustomer360Props<Extension> {
  data: Customer360Snapshot<Extension> | null;
  results: Customer360SearchResponse | null;
  state: "ready" | "loading" | "denied" | "unavailable";
  strings: AccountSupportCustomer360Strings;
  onSearch(query: string, pageSize: number): void;
  onSelect(subjectId: string): void;
  onRefresh(): void;
  renderExtension?(value: Extension): ReactNode;
}

export function AccountSupportCustomer360<Extension>({
  data,
  results,
  state,
  strings: s,
  onSearch,
  onSelect,
  onRefresh,
  renderExtension
}: AccountSupportCustomer360Props<Extension>) {
  const [query, setQuery] = useState("");
  return <section aria-label={s.title}>
    <h1>{s.title}</h1>
    <form onSubmit={event => {
      event.preventDefault();
      onSearch(query, 10);
    }}>
      <label>
        {s.query}
        <input value={query} onChange={event => setQuery(event.target.value)} />
      </label>
      <button type="submit">{s.search}</button>
    </form>
    <button type="button" onClick={onRefresh}>{s.refresh}</button>
    {state !== "ready" && <p role={state === "loading" ? "status" : "alert"}>{s[state]}</p>}
    {results && results.candidates.length === 0 && <p>{s.noMatches}</p>}
    {results?.candidates.map(candidate =>
      <button type="button" key={candidate.subjectId} onClick={() => onSelect(candidate.subjectId)}>{
        candidate.displayName ?? candidate.email ?? candidate.subjectId
      }</button>
    )}
    {data && <>
      <h2>{data.subject.displayName ?? data.subject.subjectId}</h2>
      <p>{data.subject.lifecycleStage}</p>
      {data.subject.lifecycle.map((value, i) =>
        <p key={i}>{value.stage}: {value.enteredAt ?? s.unknown} — {value.exitedAt ?? s.unknown}</p>
      )}
      {data.lookup.warnings.length > 0 && <p>{s.partial}: {data.lookup.warnings.join(", ")}</p>}
      <h3>{s.contact}</h3>
      <p>{data.subject.email ?? s.unknown}, {data.subject.phone ?? s.unknown}</p>
      <p>{
        data.contactHealth?.lastTerminalStatus ?? s.unknown
      }</p>
      <h3>{s.addresses}</h3>
      {data.addresses === undefined ? <p>{s.unknown}</p> : data.addresses.map(value =>
        <p key={value.addressId}>{value.line1}, {value.city}, {value.country}</p>
      )}
      <h3>{s.orders}</h3>
      {data.orders.map(value =>
        <p key={value.orderId}>{value.orderNumber ?? value.orderId}: {value.status}, {
          value.totalMinor === null ? s.unknown : `${value.totalMinor} ${value.currency ?? s.unknown}`
        }</p>
      )}
      <h3>{s.subscriptions}</h3>
      {data.subscriptions.map(value =>
        <p key={value.subscriptionId}>{value.subscriptionId}: {value.status}, {value.nextCycleAt ?? s.unknown}</p>
      )}
      <h3>{s.payment}</h3>
      {data.payment.map(value => <p key={value.orderId}>{value.orderId}: {value.status}</p>)}
      {data.dunningCases.map(value => <p key={value.caseId}>{value.caseId}: {value.status}, {value.nextRetryAt ?? s.unknown}</p>)}
      <h3>{s.recovery}</h3>
      {data.recovery.map(value =>
        <p key={value.caseId}>{value.caseId}: {value.status}, {value.lastDeliveryStatus ?? s.unknown}</p>
      )}
      <h3>{s.audit}</h3>
      {data.auditTrail.map(value => <p key={value.eventId}>{value.occurredAt}: {value.action}, {value.outcome}</p>)}
      {data.extension !== undefined && renderExtension?.(data.extension)}
    </>}
  </section>;
}

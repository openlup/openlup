import { useEffect, useRef, useState, type FormEvent } from "react";
import { Link, Navigate, useNavigate } from "react-router-dom";
import { useTranslation } from "react-i18next";
import { useCustomerAuth } from "@/lib/customerAuthContext";
import { customerRoutes } from "@/pages/account/login/referenceRoutes";
import type { SellableCatalogListResponse } from "@/domains/catalog/contracts";
import type { ReferenceCheckoutResponse } from "@/domains/commerce/checkoutCommandContracts";
import type { CustomerAccountV2Response } from "@/domains/customers/accountV2Contracts";
import { getCustomerAccount, applyCustomerSubscriptionAction } from "@/domains/customers/customerSelfServiceClient";
import { useAuthenticatedAccountLifecycle } from "@/domains/customers/useAuthenticatedAccountLifecycle";
import { subscriptionActionAvailability } from "@/pages/account/v2/lib/subscriptionActionAvailability";
import { hasExpiredRecoveryCase, hasOpenRecoveryCase } from "@/pages/account/v2/lib/dunningFacts";
import { RescheduleModal } from "@/pages/account/v2/subscriptions/modals/RescheduleModal";
import { createReferenceSubscription, loadReferenceItems } from "./subscriptionApi";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "This request could not be completed.";
}

type Buyer = { firstName: string; lastName: string; email: string; phone: string; street: string; postalCode: string; city: string };
const initialBuyer: Buyer = { firstName: "", lastName: "", email: "", phone: "", street: "", postalCode: "", city: "" };

export function ReferenceSubscribe() {
  const [catalog, setCatalog] = useState<SellableCatalogListResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [buyer, setBuyer] = useState<Buyer>(initialBuyer);
  const [busy, setBusy] = useState(false);
  const [checkout, setCheckout] = useState<ReferenceCheckoutResponse | null>(null);
  const intent = useRef<{ fingerprint: string; key: string } | null>(null);

  useEffect(() => {
    let active = true;
    void loadReferenceItems().then((result) => {
      if (active) setCatalog(result);
    }).catch(() => {
      if (active) setError("The recurring item is unavailable.");
    }).finally(() => {
      if (active) setLoading(false);
    });
    return () => { active = false; };
  }, []);

  const item = catalog?.items.find((candidate) => candidate.permittedPurchaseModes.includes("subscription"));
  function field(name: keyof Buyer, label: string, type = "text") {
    return <label>{label} <input type={type} required value={buyer[name]} onChange={(event) => setBuyer({ ...buyer, [name]: event.target.value })} /></label>;
  }
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy || !catalog || !item) return;
    const fingerprint = JSON.stringify([item.sku, catalog.profile.country, catalog.profile.currency, buyer]);
    if (intent.current?.fingerprint !== fingerprint) intent.current = { fingerprint, key: `reference:${crypto.randomUUID()}` };
    setBusy(true);
    setError("");
    try {
      const result = await createReferenceSubscription({ command: {
        version: "commerce.checkout_command.v1",
        idempotencyKey: intent.current.key,
        mode: "subscription",
        lines: [{ sku: item.sku, quantity: 1 }],
        customer: { firstName: buyer.firstName, lastName: buyer.lastName, email: buyer.email, phone: buyer.phone },
        shippingAddress: { street: buyer.street, postalCode: buyer.postalCode, city: buyer.city, country: catalog.profile.country },
        currency: catalog.profile.currency,
        cadenceDays: 28,
      } });
      setCheckout(result);
    } catch (cause) {
      setError(`Checkout could not be confirmed: ${errorMessage(cause)}. Retry keeps this checkout request's identity.`);
    } finally {
      setBusy(false);
    }
  }

  return (
    <main>
      <h1>Start a recurring order</h1>
      <p>This disposable reference uses a trusted captured payment provider and does not charge real money or send external mail.</p>
      {loading ? <p role="status">Loading the recurring item…</p> : null}
      {catalog && item ? (
        <>
          <h2>{item.title}</h2>
          <p>{(item.unitPrice.amountMinor / 100).toFixed(2)} {item.unitPrice.currency} every 28 days, one item per order.</p>
          <form onSubmit={submit}>
            {field("firstName", "First name")}
            {field("lastName", "Last name")}
            {field("email", "Email", "email")}
            {field("phone", "Phone", "tel")}
            {field("street", "Street address")}
            {field("postalCode", "Postal code")}
            {field("city", "City")}
            <p>Shipping country: {catalog.profile.country}. Payment outcome is selected by the trusted local server profile.</p>
            <button type="submit" disabled={busy}>{busy ? "Submitting…" : "Place recurring order"}</button>
          </form>
        </>
      ) : null}
      {error ? <p role="alert">{error}</p> : null}
      {checkout ? (
        <section aria-labelledby="checkout-result">
          <h2 id="checkout-result">Order result</h2>
          <p>Order ID: {checkout.orderId}</p>
          <p>Payment status: {checkout.paymentStatus}. {checkout.paymentStatus === "succeeded" ? "Captured in the local reference." : "An active subscription is not yet confirmed by this response."}</p>
          <p>Open the sign-in link to view the durable account state before changing a renewal date.</p>
          <Link to="/sign-in">Sign in to your account</Link>
        </section>
      ) : null}
      <p><Link to="/account">Already have an account? Open it here.</Link></p>
    </main>
  );
}

export function ReferenceAccount() {
  const { session, profile, loading, signOut: providerSignOut } = useCustomerAuth();
  const { t, i18n } = useTranslation('account');
  const routes = customerRoutes(i18n.language);
  const navigate = useNavigate();
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const lifecycle = useAuthenticatedAccountLifecycle<CustomerAccountV2Response, "account_mutation" | "account_refresh" | "subscription_mutation">({
    accessToken: profile ? session?.accessToken ?? null : null,
    principalId: session?.user.id ?? null,
    queryKey: ["reference-account", session?.user.id ?? null, profile?.clientId ?? null],
    readAccount: getCustomerAccount,
    staleTime: 30_000,
    defaultAction: "account_mutation",
    refreshAction: "account_refresh",
  });
  useEffect(() => { setSelectedId(null); setModalOpen(false); setNotice(""); }, [session?.user.id, profile?.clientId]);
  const subscriptions = lifecycle.account?.subscriptions ?? [];
  const preferred = subscriptions.find((sub) => sub.status === "active" || sub.status === "paused") ?? subscriptions[0] ?? null;
  const selected = subscriptions.find((sub) => sub.subscriptionId === selectedId) ?? preferred;
  const availability = selected ? subscriptionActionAvailability(selected, "reschedule", {
    paymentBlocked: hasOpenRecoveryCase(lifecycle.account?.actionRequired, selected.subscriptionId),
    paymentExpired: hasExpiredRecoveryCase(lifecycle.account?.actionRequired, selected.subscriptionId),
  }) : null;

  async function applyRenewal(body: Parameters<typeof applyCustomerSubscriptionAction>[1]) {
    if (!session) return;
    setNotice("");
    const result = await lifecycle.mutate(() => applyCustomerSubscriptionAction(session.accessToken, body), "subscription_mutation");
    if (result.write === "failed") setNotice(t("reference.writeFailed"));
    else if (result.read === "failed" || result.read === "stored_error") setNotice(t("reference.readFailed"));
    else if (result.ok) setNotice(t("reference.saved"));
  }

  async function signOut() {
    setSelectedId(null);
    setModalOpen(false);
    setNotice("");
    try { await providerSignOut(); } finally { navigate(routes.login, { replace: true }); }
  }

  async function refreshAccount() {
    setNotice("");
    const result = await lifecycle.refresh();
    setNotice(result.read === "succeeded" ? t("reference.refreshed")
      : t("reference.refreshFailed"));
  }

  if (loading) return <main><p role="status">{t('callback.loading')}</p></main>;
  if (!session) return <Navigate to={routes.login} replace />;
  if (!profile) return <main><p role="alert">{t('callback.accountUnavailable')}</p><button onClick={() => void signOut().catch(() => undefined)}>{t('signOut')}</button></main>;

  return (
    <main>
      <h1>{t('accountTitle')}</h1>
      {session ? (
        <>
          <button type="button" onClick={() => void signOut().catch(() => undefined)}>{t("signOut")}</button>
          {lifecycle.loadState === "loading" ? <p role="status">{t("reference.loading")}</p> : null}
          {lifecycle.loadState === "unavailable" ? <p role="alert">{t("reference.unavailable")}</p> : null}
          <button type="button" onClick={() => void refreshAccount()}>{t("reference.refresh")}</button>
          {lifecycle.account ? (
            <>
              <h2>{t("reference.orders")}</h2>
              {lifecycle.account.recentOrders.length ? <ul>{lifecycle.account.recentOrders.map((order) => <li key={order.orderId}>{order.orderNumber ?? order.orderId}: {order.status}, {t("reference.payment")} {order.paymentStatus ?? t("reference.unknown")}</li>)}</ul> : <p>{t("reference.noOrders")}</p>}
              <h2>{t("reference.subscriptions")}</h2>
              {subscriptions.length ? (
                <>
                  <label>{t("reference.choose")} <select value={selected?.subscriptionId ?? ""} onChange={(event) => { setSelectedId(event.target.value); setModalOpen(false); }}>
                    {subscriptions.map((sub) => <option key={sub.subscriptionId} value={sub.subscriptionId}>{sub.subscriptionId} — {sub.status}</option>)}
                  </select></label>
                  {selected ? <section>
                    <p>{t("reference.status", { status: selected.status })}</p>
                    <p>{t("reference.next", { date: selected.nextCycleAt ? new Intl.DateTimeFormat(i18n.language, { dateStyle: "medium" }).format(new Date(selected.nextCycleAt)) : t("reference.notScheduled") })}</p>
                    <p>{t("reference.cadence", { days: selected.cadenceDays })}</p>
                    <button type="button" disabled={!availability?.enabled} onClick={() => setModalOpen(true)}>{t("reference.change")}</button>
                    {!availability?.enabled ? <p>{t("reference.blocked")}</p> : null}
                    <RescheduleModal subscription={selected} lang={i18n.language.startsWith("pl") ? "pl" : "en"} open={modalOpen && Boolean(availability?.enabled)} onOpenChange={setModalOpen} onAction={applyRenewal} />
                  </section> : null}
                </>
              ) : <p>{t("reference.noSubscriptions")}</p>}
            </>
          ) : null}
        </>
      ) : null}
      {notice ? <p role="status">{notice}</p> : null}
      <p><Link to="/subscribe">{t("reference.return")}</Link></p>
    </main>
  );
}

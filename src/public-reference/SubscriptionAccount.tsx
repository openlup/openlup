import { useEffect, useRef, useState, type FormEvent } from "react";
import { useQueryClient } from "@tanstack/react-query";
import type { SellableCatalogListResponse } from "@/domains/catalog/contracts";
import type { ReferenceCheckoutResponse } from "@/domains/commerce/checkoutCommandContracts";
import type { CustomerAccountV2Response } from "@/domains/customers/accountV2Contracts";
import { getCustomerAccount, applyCustomerSubscriptionAction } from "@/domains/customers/customerSelfServiceClient";
import { reconcileCustomerAccount } from "@/domains/customers/customerReconcileClient";
import { useAuthenticatedAccountLifecycle } from "@/domains/customers/useAuthenticatedAccountLifecycle";
import { subscriptionActionAvailability } from "@/pages/account/v2/lib/subscriptionActionAvailability";
import { hasExpiredRecoveryCase, hasOpenRecoveryCase } from "@/pages/account/v2/lib/dunningFacts";
import { RescheduleModal } from "@/pages/account/v2/subscriptions/modals/RescheduleModal";
import {
  clearReferenceSession,
  createReferenceSubscription,
  loadReferenceItems,
  readReferenceSession,
  requestReferenceSignIn,
  saveReferenceSession,
  takeCallbackAccessToken,
  type ReferenceSession,
} from "./subscriptionApi";

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "This request could not be completed.";
}

function SignIn({ initialEmail = "" }: { initialEmail?: string }) {
  const [email, setEmail] = useState(initialEmail);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState("");
  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busy) return;
    setBusy(true);
    setNotice("");
    try {
      await requestReferenceSignIn(email);
      setNotice("If this address can sign in, a link was sent to the captured local mailbox. Open it in this browser.");
    } catch {
      setNotice("Sign-in is unavailable. Please retry later.");
    } finally {
      setBusy(false);
    }
  }
  return (
    <section aria-labelledby="signin-title">
      <h2 id="signin-title">Sign in to your account</h2>
      <p>Use the email from checkout. This disposable reference sends mail only to its local captured mailbox.</p>
      <form onSubmit={submit}>
        <label>Email <input type="email" required value={email} onChange={(event) => setEmail(event.target.value)} /></label>
        <button type="submit" disabled={busy}>{busy ? "Sending…" : "Send sign-in link"}</button>
      </form>
      {notice ? <p role="status">{notice}</p> : null}
    </section>
  );
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
          <SignIn initialEmail={buyer.email} />
        </section>
      ) : null}
      <p><a href="/account">Already have an account? Open it here.</a></p>
    </main>
  );
}

export function ReferenceAuthCallback() {
  const [notice, setNotice] = useState("Verifying your sign-in…");
  useEffect(() => {
    const accessToken = takeCallbackAccessToken();
    if (!accessToken) { setNotice("No sign-in token was provided. Request a new link."); return; }
    let active = true;
    void reconcileCustomerAccount(accessToken).then((result) => {
      if (!active) return;
      saveReferenceSession({ accessToken, accountId: result.accountId });
      window.location.replace("/account");
    }).catch(() => {
      if (active) setNotice("This sign-in could not be verified. Request a new link.");
    });
    return () => { active = false; };
  }, []);
  return <main><h1>Account sign-in</h1><p role="status">{notice}</p><a href="/account">Return to account</a></main>;
}

export function ReferenceAccount() {
  const queryClient = useQueryClient();
  const [session, setSession] = useState<ReferenceSession | null>(() => readReferenceSession());
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [notice, setNotice] = useState("");
  const lifecycle = useAuthenticatedAccountLifecycle<CustomerAccountV2Response, "account_mutation" | "account_refresh" | "subscription_mutation">({
    accessToken: session?.accessToken ?? null,
    principalId: session?.accountId ?? null,
    queryKey: ["reference-account", session?.accountId ?? null],
    readAccount: getCustomerAccount,
    staleTime: 30_000,
    defaultAction: "account_mutation",
    refreshAction: "account_refresh",
  });
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
    if (result.write === "failed") setNotice("The renewal-date change was refused or could not be confirmed. The account still shows the last known state.");
    else if (result.read === "failed" || result.read === "stored_error") setNotice("The change was submitted, but the updated account could not be read. Refresh before relying on its new date.");
    else if (result.ok) setNotice("Renewal-date change saved and account refreshed.");
  }

  function signOut() {
    clearReferenceSession();
    queryClient.clear();
    setSession(null);
    setSelectedId(null);
    setModalOpen(false);
    setNotice("Signed out of this browser tab.");
  }

  async function refreshAccount() {
    setNotice("");
    const result = await lifecycle.refresh();
    setNotice(result.read === "succeeded" ? "Account state refreshed."
      : "Account refresh could not confirm the latest state. Sign in again if the session expired.");
  }

  return (
    <main>
      <h1>Your recurring orders</h1>
      {!session ? <SignIn /> : (
        <>
          <button type="button" onClick={signOut}>Sign out</button>
          {lifecycle.loadState === "loading" ? <p role="status">Loading your account…</p> : null}
          {lifecycle.loadState === "unavailable" ? <p role="alert">Account read unavailable. Your sign-in may have expired. Sign out and request a new link if retry fails.</p> : null}
          <button type="button" onClick={() => void refreshAccount()}>Refresh account</button>
          {lifecycle.account ? (
            <>
              <h2>Orders</h2>
              {lifecycle.account.recentOrders.length ? <ul>{lifecycle.account.recentOrders.map((order) => <li key={order.orderId}>{order.orderNumber ?? order.orderId}: {order.status}, payment {order.paymentStatus ?? "unknown"}</li>)}</ul> : <p>No orders are visible yet.</p>}
              <h2>Subscriptions</h2>
              {subscriptions.length ? (
                <>
                  <label>Choose a subscription <select value={selected?.subscriptionId ?? ""} onChange={(event) => { setSelectedId(event.target.value); setModalOpen(false); }}>
                    {subscriptions.map((sub) => <option key={sub.subscriptionId} value={sub.subscriptionId}>{sub.subscriptionId} — {sub.status}</option>)}
                  </select></label>
                  {selected ? <section>
                    <p>Status: {selected.status}</p>
                    <p>Next planned renewal and charge: {selected.nextCycleAt ? new Intl.DateTimeFormat("en", { dateStyle: "medium" }).format(new Date(selected.nextCycleAt)) : "not scheduled"}. This is not a promised delivery date.</p>
                    <p>Cadence: every {selected.cadenceDays} days.</p>
                    <button type="button" disabled={!availability?.enabled} onClick={() => setModalOpen(true)}>Change next renewal date</button>
                    {!availability?.enabled ? <p>This subscription cannot be rescheduled at present.</p> : null}
                    <RescheduleModal subscription={selected} lang="en" open={modalOpen && Boolean(availability?.enabled)} onOpenChange={setModalOpen} onAction={applyRenewal} />
                  </section> : null}
                </>
              ) : <p>No subscription is visible yet. Complete checkout or retry account refresh.</p>}
            </>
          ) : null}
        </>
      )}
      {notice ? <p role="status">{notice}</p> : null}
      <p><a href="/subscribe">Return to recurring order</a></p>
    </main>
  );
}

import { useEffect, useRef, useState } from "react";
import { BffClientError } from "@/lib/bff/client";
import {
  getCatalogProduct,
  listCatalogProducts,
  listReferenceStoreItems,
} from "@/domains/catalog/catalogClient";
import { submitReferenceCheckout } from "@/domains/commerce/referenceCommerceClient";
import type {
  CatalogProductContract,
  SellableCatalogItem,
  SellableCatalogProfile,
} from "@/domains/catalog/contracts";

type LoadState = "loading" | "ready" | "unavailable";

const initialCustomer = {
  firstName: "",
  lastName: "",
  email: "",
  phone: "",
  street: "",
  postalCode: "",
  city: "",
  country: "",
};

/**
 * An intentionally unlinked local demo page. Its only data access is through
 * typed BFF clients; it neither imports nor receives database credentials.
 */
export default function ReferenceStorePage() {
  const [state, setState] = useState<LoadState>("loading");
  const [items, setItems] = useState<SellableCatalogItem[]>([]);
  const [profile, setProfile] = useState<SellableCatalogProfile | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [customer, setCustomer] = useState(initialCustomer);
  const [submitting, setSubmitting] = useState(false);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const idempotencyKey = useRef(`reference-store-${Date.now()}-${Math.random().toString(36).slice(2)}`);
  // The discovery half. It is the FIRST consumer in the application of the typed
  // catalog client's database-backed read; until this page called it, the three
  // listing functions had no caller outside a soak harness.
  const [discovery, setDiscovery] = useState<LoadState>("loading");
  const [listing, setListing] = useState<CatalogProductContract[]>([]);
  const [detail, setDetail] = useState<CatalogProductContract | null>(null);

  useEffect(() => {
    let current = true;
    void listCatalogProducts()
      .then((response) => {
        if (!current) return;
        setListing(response.products);
        setDiscovery("ready");
      })
      .catch(() => {
        if (current) setDiscovery("unavailable");
      });
    return () => { current = false; };
  }, []);

  async function openDetail(slug: string): Promise<void> {
    setDetail(null);
    try {
      setDetail((await getCatalogProduct(slug)).product);
    } catch {
      setDetail(null);
    }
  }

  useEffect(() => {
    let current = true;
    void listReferenceStoreItems()
      .then((response) => {
        if (!current) return;
        setItems(response.items);
        setProfile(response.profile);
        setCustomer((customer) => ({ ...customer, country: response.profile.country }));
        setState("ready");
      })
      .catch(() => {
        if (current) setState("unavailable");
      });
    return () => { current = false; };
  }, []);

  const item = items[0] ?? null;

  async function submit(): Promise<void> {
    if (!item) return;
    setSubmitting(true);
    setError(null);
    setResult(null);
    try {
      const checkout = await submitReferenceCheckout({
        command: {
          version: "commerce.checkout_command.v1",
          idempotencyKey: idempotencyKey.current,
          mode: "one_time",
          lines: [{ sku: item.sku, quantity }],
          customer: {
            firstName: customer.firstName,
            lastName: customer.lastName,
            email: customer.email,
            phone: customer.phone,
          },
          shippingAddress: {
            street: customer.street,
            postalCode: customer.postalCode,
            city: customer.city,
            country: customer.country.toUpperCase(),
          },
          currency: item.unitPrice.currency,
        },
      });
      const refused = checkout.paymentStatus === "failed" || checkout.paymentAttemptStatus === "failed";
      setResult(refused
        ? `Checkout refused: ${checkout.orderId}`
        : `Checkout ${checkout.replayed ? "replayed" : "created"}: ${checkout.orderId}`);
    } catch (caught) {
      const message = caught instanceof BffClientError
        ? caught.message
        : "Reference checkout is unavailable.";
      setError(message);
    } finally {
      setSubmitting(false);
    }
  }

  if (state === "loading") {
    return <main className="min-h-screen bg-cream px-6 py-16 text-ink"><p>Loading reference store…</p></main>;
  }
  if (state === "unavailable" || !item || !profile) {
    return <main className="min-h-screen bg-cream px-6 py-16 text-ink"><p>Reference store unavailable.</p></main>;
  }

  const price = new Intl.NumberFormat(profile.locale, {
    style: "currency",
    currency: item.unitPrice.currency,
  }).format(item.unitPrice.amountMinor / 100);

  return (
    <main className="min-h-screen bg-cream px-6 py-12 text-ink">
      <section className="mx-auto max-w-2xl rounded-card border border-ink/10 bg-white p-6 shadow-sm md:p-10">
        <p className="mono-label text-teal">LOCAL REFERENCE STORE</p>
        <h1 className="mt-3 font-display text-4xl font-semibold">{profile.brand}</h1>
        <p className="mt-2 font-body text-ink/65">A local-only neutral checkout reference.</p>

        <article className="mt-8 rounded-control border border-ink/10 p-5">
          <h2 className="font-display text-2xl font-semibold">{item.title}</h2>
          <p className="mt-2 font-body text-ink/65">{price} per refill</p>
          <div className="mt-5 flex flex-wrap gap-3">
            <label className="font-body text-sm" htmlFor="reference-quantity">Quantity</label>
            <input
              id="reference-quantity"
              className="w-20 rounded-control border border-ink/20 px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal"
              type="number"
              min={1}
              max={99}
              value={quantity}
              onChange={(event) => setQuantity(Math.max(1, Math.min(99, Number(event.target.value) || 1)))}
            />
            <p className="font-body text-sm">One-time purchase</p>
          </div>
        </article>

        <section className="mt-10 rounded-control border border-ink/10 p-5">
          <h2 className="font-display text-2xl font-semibold">Operator catalogue</h2>
          {discovery === "loading" && <p className="mt-2 font-body text-ink/65">Reading the catalogue…</p>}
          {discovery === "unavailable" && (
            <p aria-live="polite" className="mt-2 font-body text-sm text-ink/65">
              The catalogue route did not answer. Seed a catalogue and the listing below is the
              operator&rsquo;s own; an item published without a declared line, weight, composition or
              format is refused by the public response contract rather than shown half-built.
            </p>
          )}
          {discovery === "ready" && listing.length === 0 && (
            <p className="mt-2 font-body text-sm text-ink/65">The operator has published nothing yet.</p>
          )}
          <ul className="mt-4 space-y-2">
            {listing.map((entry) => (
              <li key={entry.slug}>
                <button
                  className="w-full rounded-control border border-ink/10 px-4 py-3 text-left font-body hover:border-teal focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal"
                  onClick={() => { void openDetail(entry.slug); }}
                  type="button"
                >
                  {entry.displayName} — {entry.variants.length} sellable unit(s)
                </button>
              </li>
            ))}
          </ul>
          {detail && (
            <article className="mt-4 rounded-control border border-teal/40 p-4">
              <h3 className="font-display text-xl font-semibold">{detail.displayName}</h3>
              <ul className="mt-2 space-y-1 font-body text-sm text-ink/65">
                {detail.variants.map((variant) => (
                  <li key={variant.sku}>
                    {variant.sku} — {variant.pricing.listPrice
                      ? `${variant.pricing.listPrice.amountMinor / 100} ${variant.pricing.listPrice.currency}`
                      : "no price configured"}
                  </li>
                ))}
              </ul>
            </article>
          )}
        </section>

        <div className="mt-8 grid gap-4 sm:grid-cols-2">
          {Object.entries(customer).map(([field, value]) => (
            <label className="font-body text-sm" key={field} htmlFor={`reference-${field}`}>
              {field.replace(/([A-Z])/g, " $1")}
              <input
                id={`reference-${field}`}
                className="mt-1 block w-full rounded-control border border-ink/20 px-3 py-2 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal"
                value={value}
                onChange={(event) => setCustomer((current) => ({ ...current, [field]: event.target.value }))}
              />
            </label>
          ))}
        </div>

        <button
          className="mt-8 rounded-control bg-teal px-5 py-3 font-body font-semibold text-white transition-colors hover:bg-teal/90 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-teal disabled:cursor-not-allowed disabled:opacity-50"
          disabled={submitting}
          onClick={() => { void submit(); }}
          type="button"
        >
          {submitting ? "Creating checkout…" : "Create local checkout"}
        </button>
        {result && <p aria-live="polite" className="mt-4 font-body text-sm text-teal">{result}</p>}
        {error && <p aria-live="polite" className="mt-4 font-body text-sm text-red-700">{error}</p>}
      </section>
    </main>
  );
}

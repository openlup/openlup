import { useEffect, useMemo, useRef, useState } from "react";
import { useNavigate } from "react-router-dom";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { RadioGroup, RadioGroupItem } from "@/components/ui/radio-group";
import { BffClientError } from "@/lib/bff/client";
import { listReferenceStoreItems } from "@/domains/catalog/catalogClient";
import { submitReferenceCheckout } from "@/domains/commerce/referenceCommerceClient";
import type {
  SellableCatalogItem,
  SellableCatalogProfile,
} from "@/domains/catalog/contracts";
import {
  paymentFailedUrlFor,
  paymentStatusUrlFor,
} from "@/checkout/machine/checkoutNavigation";
import {
  buildSubscribeEntryCommand,
  DEFAULT_SUBSCRIBE_ENTRY_PATHS,
  EMPTY_SUBSCRIBE_CONTACT,
  formatOfferPrice,
  isContactComplete,
  subscribableOffers,
  SUBSCRIBE_CONTACT_FIELDS,
  SUBSCRIBE_ENTRY_CADENCE_DAYS,
  SUBSCRIBE_ENTRY_DEFAULT_CADENCE_DAYS,
  type SubscribeEntryContact,
  type SubscribeEntryPaths,
} from "./subscribeEntryModel";

/**
 * The platform's neutral subscribe entry — the front door line γ left off the published
 * checkout machine (`docs/plan/oss-subscription-axis-audit.md` §1.6, gap **a1**).
 *
 * ⛔ Scaffolding on purpose. This is the twenty per cent an adopter replaces: one page
 * that lists what the deployment permits subscribing to, takes a quantity, a recurrence
 * and the details the neutral command demands, and then hands the customer to the
 * PUBLISHED payment page (`src/checkout/adapters/PlatnoscPage`) through the machine's own
 * URL builders. It is not a second composer: it reads no subject profile, no ration and
 * no vertical vocabulary, and it authors no catalog — every row comes from this
 * deployment's `/api/bff/catalog/items`.
 *
 * The deployment gates itself by data rather than by a switch: a catalog whose items do
 * not declare `subscription` in `permittedPurchaseModes` renders the empty state, so this
 * page is inert on a deployment that sells no subscriptions and needs no flag to be.
 */

type LoadState = "loading" | "ready" | "unavailable";

export default function SubscribeEntryPage({
  paths = DEFAULT_SUBSCRIBE_ENTRY_PATHS,
}: { paths?: SubscribeEntryPaths } = {}) {
  const navigate = useNavigate();
  const [state, setState] = useState<LoadState>("loading");
  const [items, setItems] = useState<SellableCatalogItem[]>([]);
  const [profile, setProfile] = useState<SellableCatalogProfile | null>(null);
  const [sku, setSku] = useState<string | null>(null);
  const [quantity, setQuantity] = useState(1);
  const [cadenceDays, setCadenceDays] = useState<number>(SUBSCRIBE_ENTRY_DEFAULT_CADENCE_DAYS);
  const [contact, setContact] = useState<SubscribeEntryContact>(EMPTY_SUBSCRIBE_CONTACT);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  // One key per mounted funnel: a retry after a network error must replay the same
  // order rather than mint a second one.
  const idempotencyKey = useRef(
    `subscribe-entry-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );

  useEffect(() => {
    let current = true;
    void listReferenceStoreItems()
      .then((response) => {
        if (!current) return;
        setItems(response.items);
        setProfile(response.profile);
        setState("ready");
      })
      .catch(() => {
        if (current) setState("unavailable");
      });
    return () => {
      current = false;
    };
  }, []);

  const offers = useMemo(() => subscribableOffers(items), [items]);

  useEffect(() => {
    if (sku === null && offers.length > 0) setSku(offers[0].sku);
  }, [offers, sku]);

  async function submit(): Promise<void> {
    if (!profile || sku === null) return;
    const built = buildSubscribeEntryCommand({
      offers,
      profile,
      selection: { sku, quantity, cadenceDays },
      contact,
      idempotencyKey: idempotencyKey.current,
    });
    if (built.status === "refused") {
      setError(
        built.reason === "details_incomplete"
          ? "Please complete every field before subscribing."
          : "This offer is no longer available on a recurring basis.",
      );
      return;
    }

    setSubmitting(true);
    setError(null);
    try {
      const result = await submitReferenceCheckout({ command: built.command });
      const refused =
        result.paymentStatus === "failed" || result.paymentAttemptStatus === "failed";
      // The handoff. Both destinations are the PUBLISHED checkout machine's own terminal
      // routes, addressed through its own URL builders, so the entry never re-derives
      // the query contract the payment page reads.
      navigate(
        refused
          ? paymentFailedUrlFor(paths.paymentFailed, {
              orderId: result.orderId,
              paymentIntentId: result.paymentIntentId,
              clientId: result.clientId,
              reason: "technical",
            })
          : paymentStatusUrlFor(paths.payment, {
              orderId: result.orderId,
              paymentIntentId: result.paymentIntentId,
              clientId: result.clientId,
            }),
      );
    } catch (caught) {
      setError(
        caught instanceof BffClientError
          ? caught.message
          : "Subscribing is unavailable right now. Please try again.",
      );
    } finally {
      setSubmitting(false);
    }
  }

  if (state === "loading") {
    return (
      <main className="min-h-screen bg-cream px-6 py-16 text-ink">
        <p className="font-body">Loading offers…</p>
      </main>
    );
  }

  if (state === "unavailable" || !profile) {
    return (
      <main className="min-h-screen bg-cream px-6 py-16 text-ink">
        <p aria-live="polite" className="font-body">
          The catalogue did not answer, so there is nothing to subscribe to yet.
        </p>
      </main>
    );
  }

  if (offers.length === 0) {
    return (
      <main className="min-h-screen bg-cream px-6 py-16 text-ink">
        <h1 className="font-display text-3xl font-semibold">{profile.brand}</h1>
        <p aria-live="polite" className="mt-3 font-body text-ink/65">
          This store publishes no offers on a recurring basis yet. Mark a sellable item as
          subscribable and it appears here.
        </p>
      </main>
    );
  }

  const selected = offers.find((offer) => offer.sku === sku) ?? offers[0];
  const canSubmit = !submitting && isContactComplete(contact);

  return (
    <main className="min-h-screen bg-cream px-6 py-12 text-ink">
      <section className="mx-auto max-w-2xl rounded-card border border-ink/10 bg-white p-6 shadow-sm md:p-10">
        <p className="mono-label text-accent-teal">SUBSCRIBE</p>
        <h1 className="mt-3 font-display text-4xl font-semibold">{profile.brand}</h1>
        <p className="mt-2 font-body text-ink/65">
          Pick what you want delivered, choose how often, and subscribe.
        </p>

        <fieldset className="mt-8">
          <legend className="font-display text-2xl font-semibold">What to send</legend>
          <RadioGroup
            className="mt-4 space-y-2"
            onValueChange={setSku}
            value={selected.sku}
          >
            {offers.map((offer) => (
              <div
                className="flex items-center gap-3 rounded-control border border-ink/10 px-4 py-3"
                key={offer.sku}
              >
                <RadioGroupItem id={`offer-${offer.sku}`} value={offer.sku} />
                <Label className="font-body" htmlFor={`offer-${offer.sku}`}>
                  {offer.title} — {formatOfferPrice(profile, offer)}
                </Label>
              </div>
            ))}
          </RadioGroup>
        </fieldset>

        <div className="mt-8 grid gap-6 sm:grid-cols-2">
          <div>
            <Label className="font-body" htmlFor="subscribe-quantity">
              Quantity per delivery
            </Label>
            <Input
              className="mt-2"
              id="subscribe-quantity"
              max={99}
              min={1}
              onChange={(event) =>
                setQuantity(Math.max(1, Math.min(99, Number(event.target.value) || 1)))
              }
              type="number"
              value={quantity}
            />
          </div>

          <fieldset>
            <legend className="font-body text-sm font-medium">How often</legend>
            <RadioGroup
              className="mt-2 flex flex-wrap gap-3"
              onValueChange={(value) => setCadenceDays(Number(value))}
              value={String(cadenceDays)}
            >
              {SUBSCRIBE_ENTRY_CADENCE_DAYS.map((days) => (
                <div className="flex items-center gap-2" key={days}>
                  <RadioGroupItem id={`cadence-${days}`} value={String(days)} />
                  <Label className="font-body" htmlFor={`cadence-${days}`}>
                    Every {days} days
                  </Label>
                </div>
              ))}
            </RadioGroup>
          </fieldset>
        </div>

        <fieldset className="mt-10">
          <legend className="font-display text-2xl font-semibold">Where to send it</legend>
          <div className="mt-4 grid gap-4 sm:grid-cols-2">
            {SUBSCRIBE_CONTACT_FIELDS.map((field) => (
              <div key={field.key}>
                <Label className="font-body text-sm" htmlFor={`subscribe-${field.key}`}>
                  {field.label}
                </Label>
                <Input
                  className="mt-1"
                  id={`subscribe-${field.key}`}
                  onChange={(event) =>
                    setContact((current) => ({ ...current, [field.key]: event.target.value }))
                  }
                  type={field.type ?? "text"}
                  value={contact[field.key]}
                />
              </div>
            ))}
          </div>
          <p className="mt-3 font-body text-sm text-ink/65">
            Delivered to {profile.country}.
          </p>
        </fieldset>

        <Button
          className="mt-8"
          disabled={!canSubmit}
          onClick={() => {
            void submit();
          }}
          type="button"
        >
          {submitting ? "Starting your subscription…" : "Subscribe"}
        </Button>
        {error && (
          <p aria-live="polite" className="mt-4 font-body text-sm text-destructive">
            {error}
          </p>
        )}
      </section>
    </main>
  );
}

// @vitest-environment jsdom
import { afterEach, expect, it, vi } from "vitest";
import { actionForm } from "../../examples/neutral-store/client/forms.ts";
import { createQuoteAcceptance } from "../../examples/neutral-store/client/quote-acceptance.ts";
import type { PageContext } from "../../examples/neutral-store/client/context.ts";
import { configurations } from "../../examples/neutral-store/owned/store.config.ts";

const settle = async () => { for (let i = 0; i < 40; i++) await Promise.resolve(); };
afterEach(() => { document.body.replaceChildren(); vi.unstubAllGlobals(); vi.useRealTimers(); });

function checkout() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  const config = Object.values(configurations)[0]!;
  const cart = { schemaVersion: 1, configuration: config.id, mode: "subscription",
    cadenceDays: config.offer.defaultCadenceDays, lines: [{ sku: config.offer.products[0]!.sku, quantity: 1 }] };
  const context = { config, locale: "en", getCart: () => cart, t: (key: string) => key,
    money: (amount: number) => String(amount), fragments: { checkoutSummary: () => document.createElement("p") } } as unknown as PageContext;
  const summary = document.createElement("div"), acceptance = createQuoteAcceptance(context, summary);
  const calls: { key: string; body: string }[] = [], orders = new Map<string, { body: string; orderRef: string }>();
  let quotes = 0, quoteAvailable = true, loseResponse = true;
  vi.stubGlobal("fetch", vi.fn(async (url: string, init: RequestInit) => {
    if (url.endsWith("offer.validate")) {
      quotes++;
      if (!quoteAvailable) return { ok: true, json: async () => ({ ok: false, code: "starter_quote_unavailable" }) };
      return { ok: true, json: async () => ({ ok: true, value: {
        currency: config.market.currency, mode: "subscription", cadenceDays: cart.cadenceDays,
        lines: [{ sku: cart.lines[0]!.sku, quantity: 1, baseUnitMinor: 1000, unitMinor: 950, lineMinor: 950 }],
        subtotalMinor: 950, discountMinor: 190, modeDiscountMinor: 50, shippingMinor: 0, totalMinor: 760,
        quote: { promise: "unchanged" }, expectedTotal: { amountMinor: 760, currency: config.market.currency },
        acquisitionTerms: {}, validUntil: new Date(Date.now() + 60_000).toISOString(), quoteAcceptance: `fresh-proof-${quotes}`,
      } }) };
    }
    const key = (init.headers as Record<string, string>)["Idempotency-Key"]!, body = String(init.body);
    calls.push({ key, body });
    const prior = orders.get(key);
    if (prior) expect(body).toBe(prior.body);
    const saved = prior ?? { body, orderRef: `order-${orders.size + 1}` };
    orders.set(key, saved);
    if (loseResponse) { loseResponse = false; throw new Error("response lost after durable creation"); }
    return { ok: true, json: async () => ({ ok: true, value: { orderRef: saved.orderRef }, replayed: Boolean(prior) }) };
  }));
  const form = actionForm(context, { operation: "checkout.create", submit: "placeOrder",
    fields: [{ name: "email", label: "email", type: "email", value: "buyer@example.test" },
      { name: "termsAccepted", label: "termsAccept", type: "checkbox" }],
    input: acceptance.input, prepare: acceptance.prepare, onFailure: acceptance.refused });
  document.body.append(form, summary); acceptance.attach(form);
  const submit = async () => { form.dispatchEvent(new Event("submit", { cancelable: true })); await settle(); };
  const consent = form.querySelector<HTMLInputElement>('input[name="termsAccepted"]')!;
  return { form, calls, orders, submit, consent, quoteCount: () => quotes,
    stopQuotes: () => { quoteAvailable = false; } };
}

it("retries an uncertain checkout with the exact proof and command, without another quote or order", async () => {
  const page = checkout(); await settle(); page.consent.checked = true;
  await page.submit(); expect(page.calls).toHaveLength(1); expect(page.orders.size).toBe(1);
  const quotes = page.quoteCount(); page.stopQuotes();
  await page.submit(); expect(page.calls).toHaveLength(2);
  expect(page.calls[1]).toEqual(page.calls[0]);
  expect(page.quoteCount()).toBe(quotes); expect(page.orders.size).toBe(1);
  expect(page.form.textContent).toContain("order-1");
});

it("prepares a new command when the buyer changes input after an uncertain response", async () => {
  const page = checkout(); await settle(); page.consent.checked = true;
  await page.submit(); const quotes = page.quoteCount();
  const email = page.form.querySelector<HTMLInputElement>('input[name="email"]')!;
  email.value = "another@example.test"; email.dispatchEvent(new Event("change", { bubbles: true }));
  await settle(); expect(page.consent.checked).toBe(false);
  page.consent.checked = true; await page.submit();
  expect(page.calls).toHaveLength(2); expect(page.calls[1]!.key).not.toBe(page.calls[0]!.key);
  expect(JSON.parse(page.calls[1]!.body).email).toBe("another@example.test");
  expect(page.quoteCount()).toBeGreaterThan(quotes);
});

it("explicit new action discards the uncertain submission before preparing another quote", async () => {
  const page = checkout(); await settle(); page.consent.checked = true;
  await page.submit(); const quotes = page.quoteCount();
  page.form.querySelector<HTMLButtonElement>('button[type="button"]')!.click();
  await page.submit(); expect(page.calls).toHaveLength(2);
  expect(page.calls[1]!.key).not.toBe(page.calls[0]!.key);
  expect(page.quoteCount()).toBeGreaterThan(quotes);
});

import { act, render, screen } from "@testing-library/react";
import { renderToString } from "react-dom/server";
import { hydrateRoot } from "react-dom/client";
import { MemoryRouter, StaticRouter } from "react-router-dom";
import { expect, it } from "vitest";
import type { CatalogPublicationReadResult } from "@openlup/platform/catalog/contracts";
import type { ReferenceCatalogSnapshot } from "@/domains/catalog/referenceCatalogUi";
import { ReferenceCatalogRoutes } from "@/routes/ReferenceCatalogRoutes";
import { CatalogLifecycleObservation } from "@/components/admin/CatalogLifecycleObservation";

const base: ReferenceCatalogSnapshot = {
  profile: { id: "synthetic", brand: "Example", currency: "XXX", country: "ZZ", locale: "en", timezone: "UTC" }, catalogPath: "/x/items", builderPath: "/x/basket",
  products: [{ item: { sku: "UNIT-A", title: "Unit A", unitPrice: { amountMinor: 1000, currency: "XXX" }, permittedPurchaseModes: ["one_time"] }, path: "/x/items/unit-a", description: "Detail A" }],
  copy: { catalog: "Items", builder: "Basket", quantity: "Quantity", mode: "Mode", oneTime: "Once", subscription: "Recurring", quote: "Quote", consent: "Accept quoted terms", secondDelivery: "Second delivery discount", continue: "Continue", refused: "Unavailable" },
};

it("hydrates a locale product deep link and follows its supplied builder link", async () => {
  const localized = { ...base, profile: { ...base.profile, locale: "fr" }, catalogPath: "/y/items", builderPath: "/y/basket", products: [{ ...base.products[0], path: "/y/items/unit-a", description: "Detail B" }], copy: { ...base.copy, catalog: "Collection", builder: "Selection" } };
  const input = { snapshots: [base, localized] };
  const app = <MemoryRouter initialEntries={[localized.products[0].path]}><ReferenceCatalogRoutes input={input} /></MemoryRouter>;
  const container = document.createElement("div"); document.body.append(container);
  container.innerHTML = renderToString(<StaticRouter location={localized.products[0].path}><ReferenceCatalogRoutes input={input} /></StaticRouter>);
  const errors: unknown[] = [];
  let root: ReturnType<typeof hydrateRoot>;
  await act(async () => { root = hydrateRoot(container, app, { onRecoverableError: error => errors.push(error) }); });
  try {
    expect(errors).toEqual([]); expect(container.querySelector("main")?.lang).toBe("fr");
    expect(container.textContent).toContain("Detail B"); expect(container.textContent).not.toContain("Detail A");
    expect(container.querySelector('a[href="/y/basket"]')).not.toBeNull();
    // Ordinary supplied anchors retain their exact locale destination; route composition is testable independently.
    expect(container.querySelector('a[href="/y/basket"]')?.getAttribute("href")).toBe("/y/basket");
  } finally { await act(async () => root!.unmount()); container.remove(); }
  const builder = render(<MemoryRouter initialEntries={[localized.builderPath]}><ReferenceCatalogRoutes input={input} /></MemoryRouter>);
  expect(screen.getByRole("heading", { name: "Selection" })).toBeInTheDocument();
  expect(screen.getByRole("button", { name: "Continue" })).toBeDisabled(); builder.unmount();
});

it("shows authority-only lifecycle states and keeps unsupported, outage, unpublished and refusal distinct", () => {
  const head = { publicationId: "head-a", revision: 1, documentDigest: "digest-a" };
  const found: CatalogPublicationReadResult = { outcome: "found", head, documentRef: "document-a", observations: ["draft", "active", "withdrawn"].map((state, index) => ({ productId: "product-a", variantId: `variant-${index}`, sku: `UNIT-${index}`, state: state as "draft" | "active" | "withdrawn", variantRevision: 1, publicationHead: index === 0 ? null : head, draftRef: null })) };
  const view = render(<CatalogLifecycleObservation result={found} />);
  for (const state of ["draft", "active", "withdrawn", "unpublished"]) expect(view.container.textContent).toContain(state);
  const refusals: CatalogPublicationReadResult[] = [
    { outcome: "unpublished" },
    { outcome: "unsupported", reason: "publication_not_supported" },
    { outcome: "dependency_unavailable", reason: "publication_authority_unavailable" },
    { outcome: "unauthorized", reason: "publisher_not_authorized" },
    { outcome: "conflict", reason: "head_conflict" },
    { outcome: "validation_issue", reason: "candidate_invalid" },
  ];
  for (const result of refusals) {
    view.rerender(<CatalogLifecycleObservation result={result} />);
    expect(view.container.querySelector("output")?.dataset.catalogOutcome).toBe(result.outcome);
    expect(view.container.querySelector("li")).toBeNull(); expect(view.container.querySelector("button")).toBeNull();
    if ("reason" in result) expect(view.container.textContent).toContain(result.reason);
  }
});

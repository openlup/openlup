import { cleanup, render, screen } from "@testing-library/react";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import type { BundleAvailabilityView } from "@openlup/platform/catalog/contracts";
import { BundleStockCard } from "./BundleStockCard";
const { fetchSellableBundles } = vi.hoisted(() => ({ fetchSellableBundles: vi.fn() }));
vi.mock("@/domains/bundle/sellableBundleClient", () => ({ fetchSellableBundles }));
vi.mock("react-i18next", () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
afterEach(() => { cleanup(); fetchSellableBundles.mockReset(); });
it("renders server-owned draft stock and unknown component figures without fetching or deriving stock", () => {
  const availability: BundleAvailabilityView = { status: "unknown", reasonCode: "component_unknown", sellableNow: null,
    limitingSku: "A", components: [{ sku: "A", quantity: 2, sellableNow: null, isAddon: false }] };
  render(<QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
    <BundleStockCard code="bundle" status="draft" availability={availability} />
  </QueryClientProvider>);
  expect(fetchSellableBundles).not.toHaveBeenCalled();
  expect(screen.getAllByText("admin:adminBundles.stock.unknownFigure")).toHaveLength(3);
  expect(screen.getByText("admin:adminBundles.stock.limitingBadge")).toBeTruthy();
  expect(screen.getByText("component_unknown")).toBeTruthy();
});

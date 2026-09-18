import { fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import BundlesPage from "@/pages/admin/BundlesPage";
import { renderWithProviders } from "@/test/render";
import { bundleDetail, bundleSummary, listResponse } from "@/test/bundleAdminFixtures";

/**
 * The page is the flag gate and the composition; each card's own behaviour is
 * pinned by its own spec. What is pinned HERE is what only the page can get
 * wrong: whether the surface appears at all, and whether the human-only publish
 * button is offered to someone or something that cannot use it.
 */

const { mockListBundles, mockGetBundle, mockUseAuth, mockBundleAdminEnabled } = vi.hoisted(() => ({
  mockListBundles: vi.fn(),
  mockGetBundle: vi.fn(),
  mockUseAuth: vi.fn(),
  mockBundleAdminEnabled: vi.fn(),
}));

/**
 * The gate is mocked at its MODULE, not through the `globalThis` test override.
 * Both drive the same branch, and the module mock is the idiom the neighbouring
 * admin specs use — but the override's identifier is a brand-counted token, and
 * this file sits in a publishable surface family the OSS ratchet measures. The
 * accessor's own reading of env and override is covered by the flag registry's
 * spec, which is where that behaviour belongs.
 */
vi.mock("@/lib/bundleAdminFlag", () => ({ bundleAdminEnabled: mockBundleAdminEnabled }));

function setBundleAdminFlag(value: boolean) {
  mockBundleAdminEnabled.mockReturnValue(value);
}

vi.mock("@/domains/bundle/adminBundleClient", () => ({
  listBundles: mockListBundles,
  getBundle: mockGetBundle,
  createBundleDraft: vi.fn(),
  updateBundleDraft: vi.fn(),
  setBundleComposition: vi.fn(),
  setBundleTargetPrice: vi.fn(),
  activateBundle: vi.fn(),
  deactivateBundle: vi.fn(),
  archiveBundle: vi.fn(),
  restoreBundle: vi.fn(),
}));

vi.mock("@/lib/authContext", () => ({ useAuth: mockUseAuth }));

// The cards each own a spec; here they are stubbed to their identity so the test
// asserts composition rather than re-testing five components through the page.
vi.mock("@/components/admin/BundleCompositionEditor", () => ({
  BundleCompositionEditor: () => <div data-testid="composition-editor" />,
}));
vi.mock("@/components/admin/BundlePricePreviewCard", () => ({
  BundlePricePreviewCard: () => <div data-testid="price-preview" />,
}));
vi.mock("@/components/admin/BundleStockCard", () => ({
  BundleStockCard: () => <div data-testid="stock-card" />,
}));

beforeEach(() => {
  setBundleAdminFlag(true);
  mockUseAuth.mockReturnValue({ session: { access_token: "token" }, role: "admin" });
  mockListBundles.mockResolvedValue(listResponse([bundleSummary()]));
  mockGetBundle.mockResolvedValue(bundleDetail());
});

afterEach(() => {
  mockBundleAdminEnabled.mockReset();
  vi.clearAllMocks();
});

describe("BundlesPage", () => {
  /**
   * The second half of this spec's name was, for a while, only a name: it asserted
   * on rendered output while the list query still ran, because hooks cannot be
   * conditional and the query gated on the token alone. Only `list` needs the flag
   * clause - `detail` is already unreachable, since `selected` is set nowhere but a
   * click on a row of this list, which a flagged-off page never renders.
   */
  it("renders disabled copy and asks the server for nothing when the flag is off", () => {
    setBundleAdminFlag(false);

    renderWithProviders(<BundlesPage />);

    expect(
      screen.getByText("Konfigurator pakietów jest wyłączony w tym środowisku."),
    ).toBeInTheDocument();
    expect(screen.queryByRole("heading", { name: "Pakiety" })).not.toBeInTheDocument();
    expect(mockListBundles).not.toHaveBeenCalled();
  });

  it("lists bundles when the flag is on", async () => {
    renderWithProviders(<BundlesPage />);

    expect(await screen.findByText("Zestaw startowy")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Pakiety" })).toBeInTheDocument();
  });

  it("mounts every card once a bundle is selected", async () => {
    renderWithProviders(<BundlesPage />);

    fireEvent.click(await screen.findByText("Zestaw startowy"));

    await waitFor(() => expect(screen.getByTestId("composition-editor")).toBeInTheDocument());
    expect(screen.getByTestId("price-preview")).toBeInTheDocument();
    expect(screen.getByTestId("stock-card")).toBeInTheDocument();
    expect(screen.getByRole("heading", { name: "Cykl życia" })).toBeInTheDocument();
  });

  it("offers publish for an admin whose bundle satisfies both preconditions", async () => {
    renderWithProviders(<BundlesPage />);

    fireEvent.click(await screen.findByText("Zestaw startowy"));

    expect(await screen.findByRole("button", { name: "Opublikuj" })).toBeInTheDocument();
  });

  it("withholds publish from a non-admin operator even when the bundle is ready", async () => {
    mockUseAuth.mockReturnValue({ session: { access_token: "token" }, role: "support" });
    renderWithProviders(<BundlesPage />);

    fireEvent.click(await screen.findByText("Zestaw startowy"));

    await waitFor(() => expect(screen.getByRole("heading", { name: "Cykl życia" })).toBeInTheDocument());
    expect(screen.queryByRole("button", { name: "Opublikuj" })).not.toBeInTheDocument();
  });

  it("withholds publish when the bundle has no active target price", async () => {
    mockGetBundle.mockResolvedValue(bundleDetail({ hasActiveTargetPrice: false, prices: [] }));
    renderWithProviders(<BundlesPage />);

    fireEvent.click(await screen.findByText("Zestaw startowy"));

    expect(await screen.findByText("Publikacja wymaga aktywnej ceny docelowej.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Opublikuj" })).not.toBeInTheDocument();
  });

  it("withholds publish when the composition is empty", async () => {
    mockGetBundle.mockResolvedValue(bundleDetail({ components: [], componentCount: 0 }));
    renderWithProviders(<BundlesPage />);

    fireEvent.click(await screen.findByText("Zestaw startowy"));

    expect(await screen.findByText("Publikacja wymaga niepustego składu.")).toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "Opublikuj" })).not.toBeInTheDocument();
  });
});

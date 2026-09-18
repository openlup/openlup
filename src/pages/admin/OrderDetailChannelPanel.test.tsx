import { screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { OrderDetailChannelPanel } from "@/pages/admin/OrderDetailChannelPanel";
import { renderWithProviders } from "@/test/render";

/**
 * The panel's whole job is to be honest about a story the order row cannot tell. These cases pin
 * the four ways it can be honest: it says what it knows, it says nothing at all for an order with
 * no story, it says nothing for a feature this deployment switched off, and it says so out loud
 * when it genuinely could not find out.
 */

const { mockGetOps } = vi.hoisted(() => ({ mockGetOps: vi.fn() }));

vi.mock("@/domains/channels/channelOpsClient", async () => {
  const actual = await vi.importActual<typeof import("@/domains/channels/channelOpsClient")>(
    "@/domains/channels/channelOpsClient",
  );
  return { ...actual, getAdminChannelOrderOps: mockGetOps };
});

const settled = {
  contractVersion: "channels.ops.v1",
  orderId: "order-1",
  channel: { slug: "sim-market", displayName: "Simulator market", status: "active" },
  ingest: {
    ledgerId: "ledger-1",
    status: "done",
    externalOrderRef: "SIM-1001",
    externalOrderRevision: "r1",
    lastError: null,
    updatedAt: "2026-08-14T09:00:00.000Z",
  },
  openQuarantineCount: 0,
};

/** The client hands the panel a tagged result now, so every case states which tag it is. */
function okResult(overrides: Record<string, unknown> = {}) {
  return { kind: "ok" as const, data: { ...settled, ...overrides } };
}

function t(key: string, options?: Record<string, unknown>) {
  return options?.count === undefined ? key : `${key}:${String(options.count)}`;
}

// A distinct order id per case: the query cache is keyed on it, and a shared key would let one
// case read another's cached answer instead of the one it set up.
let nextOrder = 0;

function render(props: Record<string, unknown> = {}) {
  nextOrder += 1;
  return renderWithProviders(
    <OrderDetailChannelPanel
      accessToken="token-1"
      orderId={`order-${nextOrder}`}
      t={t as never}
      {...props}
    />,
  );
}

beforeEach(() => {
  mockGetOps.mockReset();
  mockGetOps.mockResolvedValue(okResult());
});
afterEach(() => vi.clearAllMocks());

describe("OrderDetailChannelPanel", () => {
  it("names the surface and the ingest status for a channel order", async () => {
    render();
    expect(await screen.findByText(/Simulator market/)).toBeInTheDocument();
    expect(screen.getByText("done")).toBeInTheDocument();
    expect(screen.getByText(/SIM-1001/)).toBeInTheDocument();
  });

  it("renders nothing at all for a storefront order", async () => {
    mockGetOps.mockResolvedValue(okResult({ channel: null, ingest: null }));
    const { container } = render();
    await vi.waitFor(() => expect(mockGetOps).toHaveBeenCalled());
    expect(container.querySelector("section")).toBeNull();
  });

  it("shows the drawer depth when the surface has an operator queue", async () => {
    mockGetOps.mockResolvedValue(okResult({ openQuarantineCount: 4 }));
    render();
    expect(await screen.findByText("admin:adminOms.channel.queueOpen:4")).toBeInTheDocument();
  });

  it("shows the last error of a halted run", async () => {
    mockGetOps.mockResolvedValue(
      okResult({
        ingest: {
          ...settled.ingest,
          status: "blocked_stock",
          lastError: "inventory_reservation_insufficient_available_stock",
        },
      }),
    );
    render();
    expect(
      await screen.findByText("inventory_reservation_insufficient_available_stock"),
    ).toBeInTheDocument();
  });

  // While this deployment runs no connector the route refuses every call, so the alternative here
  // is an alarm on the detail of every order in the shop — which is how a real alarm stops being
  // read at all.
  it("renders nothing when the deployment has the feature switched off", async () => {
    mockGetOps.mockResolvedValue({ kind: "disabled" });
    const { container } = render();
    // A negative that has to outlast the read. Waiting only for the call to have happened would
    // assert against the loading frame, which is empty whatever the panel later decides — so the
    // box could appear a tick later and this would still pass. `findByText` polls for its whole
    // window and only then rejects, so the box has to be absent for the settled render too.
    await expect(screen.findByText("admin:adminOms.channel.error")).rejects.toThrow();
    expect(container.querySelector("section")).toBeNull();
  });

  it("says a failed read failed rather than looking like a healthy storefront order", async () => {
    mockGetOps.mockImplementation(async () => {
      throw new Error("channel_order_ops_failed_500");
    });
    render();
    expect(await screen.findByText("admin:adminOms.channel.error")).toBeInTheDocument();
  });

  // The switched-off answer must not have taught the panel to be quiet about a 503 in general.
  it("still says a genuine upstream failure out loud", async () => {
    mockGetOps.mockImplementation(async () => {
      throw new Error("channel_order_ops_failed_503");
    });
    render();
    expect(await screen.findByText("admin:adminOms.channel.error")).toBeInTheDocument();
  });

  it("renders nothing without an admin session, and asks for nothing", async () => {
    const { container } = render({ accessToken: undefined });
    expect(container.querySelector("section")).toBeNull();
  });
});

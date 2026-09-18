import { describe, expect, it } from "vitest";
import { render, screen, within } from "@testing-library/react";

import { DeliveryTimeline } from "./DeliveryTimeline";

// Wed 29 Jul 2026, 10:49 Warsaw — a business day before the 16:00 cut-off, so
// the parcel dispatches same day and the estimated window is Thu 30 / Fri 31.
const NEXT_CYCLE = "2026-07-29T08:49:49.000Z";

describe("DeliveryTimeline", () => {
  it("without an in-flight delivery, nextCycleAt is the nearest (coral) node", () => {
    render(<DeliveryTimeline nextCycleAt={NEXT_CYCLE} cadenceDays={21} lang="pl" />);
    const items = screen.getAllByRole("listitem");
    // First node = the START of the estimated delivery window, not the charge.
    // Short numeric format: the long form wraps at 375px (see the component).
    expect(within(items[0]).getByText("30.07")).toBeInTheDocument();
    expect(within(items[0]).getByText("szacowana")).toBeInTheDocument();
    expect(within(items[0]).queryByText("29.07")).not.toBeInTheDocument();
    expect(within(items[0]).queryByText("30 lipca")).not.toBeInTheDocument();
    expect(screen.queryByText("W realizacji")).not.toBeInTheDocument();
  });

  it("keeps node labels as short single dates and carries the range in one shared note", () => {
    render(<DeliveryTimeline nextCycleAt={NEXT_CYCLE} cadenceDays={21} lang="pl" />);
    // Measured constraint: a node box is 54.8-58px at 375px. A range label
    // (~87px) would break node alignment, and the long form ("30 czerwca" =
    // 58px) wraps to two lines. Every node label must be short numeric d.MM.
    for (const item of screen.getAllByRole("listitem")) {
      expect(item.textContent ?? "").not.toMatch(/–\d|\d–/);
    }
    for (const item of screen.getAllByRole("listitem")) {
      expect(item.textContent ?? "").not.toMatch(/lipca|sierpnia|września/);
    }
    expect(screen.getByText("30.07")).toBeInTheDocument();
    expect(
      screen.getByText("Daty dostaw są szacowane na podstawie planowanego odnowienia i opłaty."),
    ).toBeInTheDocument();
  });

  it("with an in-flight delivery, prepends the real parcel and keeps projected nodes as deliveries", () => {
    render(
      <DeliveryTimeline
        nextCycleAt={NEXT_CYCLE}
        cadenceDays={21}
        lang="pl"
        inFlight={{ orderId: "o1", phaseIndex: 1, step: "accepted" }}
      />,
    );
    const items = screen.getAllByRole("listitem");
    // Node 0 = the in-flight first delivery (non-editable). Subtitle is the REAL
    // fulfilment stage now (accepted → "Przyjęte"), not a hardcoded "W drodze".
    expect(within(items[0]).getByText("W realizacji")).toBeInTheDocument();
    expect(within(items[0]).getByText("Przyjęte")).toBeInTheDocument();
    expect(within(items[0]).queryByText("W drodze")).not.toBeInTheDocument();
    // Node 1 is still a delivery estimate derived from nextCycleAt. The raw
    // renewal/charge date belongs in the facts outside this timeline.
    expect(within(items[1]).getByText("30.07")).toBeInTheDocument();
    expect(within(items[1]).queryByText("29.07")).not.toBeInTheDocument();
    expect(within(items[1]).queryByText("Następne odnowienie")).not.toBeInTheDocument();
    expect(screen.queryByText("szacowana")).not.toBeInTheDocument();
  });

  it("keeps the node count stable (5) when an in-flight node is added", () => {
    const { rerender } = render(<DeliveryTimeline nextCycleAt={NEXT_CYCLE} cadenceDays={21} lang="pl" />);
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
    rerender(
      <DeliveryTimeline
        nextCycleAt={NEXT_CYCLE}
        cadenceDays={21}
        lang="pl"
        inFlight={{ orderId: "o1", phaseIndex: 1, step: "accepted" }}
      />,
    );
    expect(screen.getAllByRole("listitem")).toHaveLength(5);
  });

  it("renders the in-flight subtitle from the real step (paid → Opłacone)", () => {
    render(
      <DeliveryTimeline
        nextCycleAt={NEXT_CYCLE}
        cadenceDays={21}
        lang="pl"
        inFlight={{ orderId: "o1", phaseIndex: 0, step: "paid" }}
      />,
    );
    const items = screen.getAllByRole("listitem");
    expect(within(items[0]).getByText("Opłacone")).toBeInTheDocument();
  });
});

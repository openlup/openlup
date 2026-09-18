import { screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import type { TFunction } from "i18next";

import type { OmsOrderDetail } from "@/domains/commerce/omsContracts";
import { ChannelSourceSection } from "@/pages/admin/OrderDetailChannelSourceSection";
import { renderWithProviders } from "@/test/render";

// The section reads four fields and nothing else, so the fixture states exactly
// those and casts once rather than reproducing the whole detail contract.
function detailWith(source: {
  sourceKind?: string;
  sourceChannelSlug?: string;
  sourceOrderRef?: string;
}): OmsOrderDetail {
  return source as unknown as OmsOrderDetail;
}

const t = ((key: string, options?: { defaultValue?: string }) =>
  options?.defaultValue ?? key) as unknown as TFunction;

describe("ChannelSourceSection", () => {
  it("renders nothing for a storefront order, which names no channel", () => {
    const { container } = renderWithProviders(
      <ChannelSourceSection detail={detailWith({ sourceKind: "storefront" })} t={t} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("renders nothing for an order that predates the source axis", () => {
    const { container } = renderWithProviders(
      <ChannelSourceSection detail={detailWith({})} t={t} />,
    );
    expect(container).toBeEmptyDOMElement();
  });

  it("shows the channel slug and the far side's own order reference verbatim", () => {
    renderWithProviders(
      <ChannelSourceSection
        detail={detailWith({
          sourceKind: "marketplace",
          sourceChannelSlug: "marketplace-eu",
          sourceOrderRef: "EXT-1001",
        })}
        t={t}
      />,
    );
    expect(screen.getByTestId("admin-oms-channel-source")).toBeInTheDocument();
    expect(screen.getByText("marketplace-eu")).toBeInTheDocument();
    expect(screen.getByText("EXT-1001")).toBeInTheDocument();
  });

  it("falls back to the stored kind token rather than a missing-translation marker", () => {
    // Selling surfaces are an open registry: a kind this build has no label for
    // must still read as itself.
    renderWithProviders(
      <ChannelSourceSection
        detail={detailWith({
          sourceKind: "kiosk",
          sourceChannelSlug: "airport-kiosk",
          sourceOrderRef: "K-7",
        })}
        t={t}
      />,
    );
    expect(screen.getByText("kiosk")).toBeInTheDocument();
  });

  it("names the absence when the channel reported no order reference", () => {
    renderWithProviders(
      <ChannelSourceSection
        detail={detailWith({ sourceKind: "marketplace", sourceChannelSlug: "marketplace-eu" })}
        t={t}
      />,
    );
    expect(screen.getByText("admin:adminOms.detail.channelExternalOrderRefMissing"))
      .toBeInTheDocument();
  });
});

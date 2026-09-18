import type { TFunction } from "i18next";
import { describe, expect, it } from "vitest";

import { buildAdminFulfillmentActionPresentation } from "./fulfillmentActionPresentation";

// Fake t: echoes the key and appends the interpolated provider so we can assert both
// which key was chosen and that the provider name flowed through.
const fakeT = ((key: string, opts?: Record<string, unknown>) => {
  const provider = opts && typeof opts.provider === "string" ? opts.provider : "";
  return provider ? `${key}::${provider}` : key;
}) as unknown as TFunction;

describe("buildAdminFulfillmentActionPresentation", () => {
  it("keeps the manual chain for a 3PL-less provider (simulator / hidden preview)", () => {
    const p = buildAdminFulfillmentActionPresentation("hidden_preview_fulfillment", fakeT);
    expect(p.autoLabelAndHandoff).toBe(false);
    expect(p.autoDispatchNotice).toBeNull();
    expect(p.autoMonitorChip).toBeNull();
    expect(p.createFulfillmentLabel).toBe("admin:adminOms.actions.createFulfillmentByRole.simulator::Simulator");
  });

  it("switches an auto-dispatch 3PL (OmniPack) to the auto label/hand-off shape", () => {
    const p = buildAdminFulfillmentActionPresentation("omnipack", fakeT);
    expect(p.autoLabelAndHandoff).toBe(true);
    expect(p.autoDispatchNotice).toBe("admin:adminOms.actions.autoDispatchNotice::OmniPack");
    expect(p.autoMonitorChip).toBe("admin:adminOms.actions.autoLabelChip::OmniPack");
    expect(p.createFulfillmentLabel).toBe("admin:adminOms.actions.createFulfillmentByRole.third_party_logistics::OmniPack");
  });

  it("falls back to the generic create label and manual chain for an unknown provider", () => {
    const p = buildAdminFulfillmentActionPresentation(null, fakeT);
    expect(p.policy).toBeNull();
    expect(p.autoLabelAndHandoff).toBe(false);
    expect(p.createFulfillmentLabel).toBe("admin:adminOms.actions.createFulfillment");
  });

  it("exposes a per-action hint key", () => {
    const p = buildAdminFulfillmentActionPresentation("manual", fakeT);
    expect(p.hint("recordLabel")).toBe("admin:adminOms.actions.hint.recordLabel");
    expect(p.hint("markRefunded")).toBe("admin:adminOms.actions.hint.markRefunded");
  });
});

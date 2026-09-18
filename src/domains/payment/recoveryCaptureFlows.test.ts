import { describe, expect, it } from "vitest";

import {
  drivableRecoveryCaptureHandoffs,
  recoveryCaptureFlowCatalog,
  resolveRecoveryCaptureFlows,
} from "./recoveryCaptureFlows.js";

describe("recovery capture flows", () => {
  it("offers exactly one repair flow on this deployment's own catalog", () => {
    // The production answer, read from the shipped catalog rather than restated:
    // a card is the universal mandate-capable fallback and the only rail whose
    // handoff this client drives.
    expect(resolveRecoveryCaptureFlows()).toEqual({
      offered: ["card_on_file_setup"],
      excluded: [{ flowKind: "scheme_alias_registration", reason: "handoff_not_implemented_by_client" }],
    });
  });

  it("offers one option per declared flow rather than a fixed single flow", () => {
    // A simulated rail, never a second production path: two flows whose handoff
    // this client already drives must both be offered, which is what makes the
    // surface capability-driven instead of hardcoded to one.
    const simulator = [
      { kind: "simulated_first_setup", handoff: "embedded_client_secret" },
      { kind: "simulated_second_setup", handoff: "embedded_client_secret" },
    ] as const;
    expect(resolveRecoveryCaptureFlows(simulator)).toEqual({
      offered: ["simulated_first_setup", "simulated_second_setup"],
      excluded: [],
    });
  });

  it("refuses a declared flow whose handoff no renderer implements, with the reason", () => {
    const simulator = [{ kind: "simulated_code_setup", handoff: "payer_supplied_code" }] as const;
    expect(resolveRecoveryCaptureFlows(simulator)).toEqual({
      offered: [],
      excluded: [{ flowKind: "simulated_code_setup", reason: "handoff_not_implemented_by_client" }],
    });
  });

  it("collapses two rails declaring the same repair into one option", () => {
    const simulator = [
      { kind: "card_on_file_setup", handoff: "embedded_client_secret" },
      { kind: "card_on_file_setup", handoff: "embedded_client_secret" },
    ] as const;
    expect(resolveRecoveryCaptureFlows(simulator).offered).toEqual(["card_on_file_setup"]);
  });

  it("keeps the drivable set at the one handoff the repair page implements", () => {
    // Widening this without a renderer is how a declared capability becomes a
    // dead control; the guard is cheap and the failure is expensive.
    expect(drivableRecoveryCaptureHandoffs).toEqual(["embedded_client_secret"]);
    expect(recoveryCaptureFlowCatalog.every((flow) => flow.kind.length > 0)).toBe(true);
  });
});

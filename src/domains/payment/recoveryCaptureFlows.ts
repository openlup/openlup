import type { PaymentMethodCaptureFlow, PaymentMethodCaptureHandoff } from "@openlup/core/payment";

/**
 * Every customer-present capture flow this deployment's payment adapters
 * publish, for the browser surface that renders payment repair.
 *
 * The adapters publish the same flows inside their capability descriptors, and
 * that is where the server reads them from. This copy exists because the repair
 * page must not import a server adapter and holds no injected registry, exactly
 * as `./storedMethodCapabilities.ts` does for the stored-method verdict. The two
 * declarations are held equal by a test that reads both
 * (`server/adapters/paymentProviderCapabilityRegistry.test.ts`), so a rail that
 * gains or loses a capture flow cannot leave the customer surface stale.
 *
 * Nothing here is keyed by provider identity: the surface asks what can be
 * captured, never who would capture it.
 */
export const recoveryCaptureFlowCatalog: readonly PaymentMethodCaptureFlow[] = [
  { kind: "card_on_file_setup", handoff: "embedded_client_secret" },
  { kind: "scheme_alias_registration", handoff: "payer_supplied_code" },
];

/**
 * The handoffs the payment-repair page can actually drive.
 *
 * One entry, deliberately: a card is the universal mandate-capable fallback and
 * stays the only production repair option. A second entry is a product decision
 * with its own renderer, never a side effect of an adapter declaring a flow.
 */
export const drivableRecoveryCaptureHandoffs: readonly PaymentMethodCaptureHandoff[] = [
  "embedded_client_secret",
];

export type { PaymentMethodCaptureFlow, PaymentMethodCaptureHandoff };

/** Why a declared capture flow is not offered to the payer. */
export type RecoveryCaptureFlowExclusionReason = "handoff_not_implemented_by_client";

export interface RecoveryCaptureFlowExclusion {
  flowKind: string;
  reason: RecoveryCaptureFlowExclusionReason;
}

export interface RecoveryCaptureFlowResolution {
  /** Flow kinds the surface may render, in declaration order. */
  offered: readonly string[];
  /** Declared flows the surface refused, each with the reason it refused. */
  excluded: readonly RecoveryCaptureFlowExclusion[];
}

/**
 * Splits declared capture flows into what this client may offer and what it
 * must refuse.
 *
 * Fail-closed by construction: a flow is offered only when its handoff appears
 * in the drivable set, so a rail that declares a capability nobody implemented
 * yet is excluded with a stated reason instead of being rendered as a control
 * that leads nowhere. Duplicate kinds collapse to their first declaration; two
 * rails offering the same repair are one option to the payer, not two.
 */
export function resolveRecoveryCaptureFlows(
  declared: readonly PaymentMethodCaptureFlow[] = recoveryCaptureFlowCatalog,
  drivable: readonly PaymentMethodCaptureHandoff[] = drivableRecoveryCaptureHandoffs,
): RecoveryCaptureFlowResolution {
  const offered: string[] = [];
  const excluded: RecoveryCaptureFlowExclusion[] = [];
  for (const flow of declared) {
    if (!drivable.includes(flow.handoff)) {
      excluded.push({ flowKind: flow.kind, reason: "handoff_not_implemented_by_client" });
      continue;
    }
    if (!offered.includes(flow.kind)) offered.push(flow.kind);
  }
  return { offered, excluded };
}

import type {
  PaymentMethodCaptureFlow,
  PaymentMethodCaptureHandoff,
  PaymentProviderCapabilityDescriptor,
  PaymentProviderCapabilityRegistry,
} from "@openlup/core/payment";
import type {
  AdapterCaptureHandoff,
  CoreCapabilityOverrides,
  PaymentAdapter,
  PaymentAdapterCapabilities,
  PaymentMethodHandoff,
  PaymentProviderRegistry,
  PaymentReadbackPort,
  PaymentRepairMethodPort,
} from "./contracts/index.js";

/** Translate a platform adapter capture handoff into the core repair-capture vocabulary. */
export function toCoreCaptureHandoff(handoff: AdapterCaptureHandoff): PaymentMethodCaptureHandoff | null {
  switch (handoff) {
    case "client-confirmed":
      return "embedded_client_secret";
    case "customer-authorization":
      return "payer_supplied_code";
    case "redirect":
      return null;
    default: {
      const exhaustive: never = handoff;
      throw new Error(`unknown_adapter_capture_handoff:${String(exhaustive)}`);
    }
  }
}

/** Translate a core repair-capture handoff back into the platform adapter vocabulary. */
export function fromCoreCaptureHandoff(
  handoff: PaymentMethodCaptureHandoff,
): Exclude<AdapterCaptureHandoff, "redirect"> {
  switch (handoff) {
    case "embedded_client_secret":
      return "client-confirmed";
    case "payer_supplied_code":
      return "customer-authorization";
    default: {
      const exhaustive: never = handoff;
      throw new Error(`unknown_core_capture_handoff:${String(exhaustive)}`);
    }
  }
}

/** Project platform adapter capabilities onto the core capability descriptor with optional host policy overrides. */
export function toCorePaymentProviderCapability(
  capabilities: PaymentAdapterCapabilities,
  overrides?: CoreCapabilityOverrides,
): PaymentProviderCapabilityDescriptor {
  const translatedFlows: PaymentMethodCaptureFlow[] = [];
  for (const flow of capabilities.captureFlows) {
    const handoff = toCoreCaptureHandoff(flow.handoff);
    if (handoff !== null) {
      translatedFlows.push(Object.freeze({ kind: flow.kind, handoff }));
    }
  }
  return Object.freeze({
    providerKind: capabilities.providerKind,
    requiresStoredMandateEvidence: capabilities.requiresStoredMandateEvidence,
    assessMandate: capabilities.assessMandate,
    unattendedChargeFlow: capabilities.unattendedChargeFlow,
    payerContext: Object.freeze(overrides?.payerContext ? { ...overrides.payerContext } : { ...capabilities.payerContext }),
    methodHealth: Object.freeze({ ...capabilities.methodHealth }),
    terminalOutcomeReporting: Object.freeze({ ...capabilities.terminalOutcomeReporting }),
    mandateUpsertIsSubscriptionScoped: capabilities.mandateUpsertIsSubscriptionScoped,
    captureFlows: Object.freeze(
      overrides?.captureFlows
        ? overrides.captureFlows.map((flow) => Object.freeze({ ...flow }))
        : translatedFlows,
    ),
  });
}

export function createPaymentProviderRegistry(
  adapters: readonly PaymentAdapter[],
): PaymentProviderRegistry {
  const byKind = new Map<string, PaymentAdapter>();
  for (const adapter of adapters) {
    const rawKind = adapter.capabilities.providerKind;
    const kind = rawKind.trim();
    if (!kind) {
      throw new Error("payment_provider_kind_required");
    }
    if (kind !== rawKind) {
      throw new Error(`payment_provider_kind_untrimmed:${kind}`);
    }
    if (byKind.has(kind)) {
      throw new Error(`duplicate_payment_provider_kind:${kind}`);
    }
    byKind.set(kind, adapter);
  }
  const kindsList = Object.freeze([...byKind.keys()]);

  return {
    get(providerKind: string): PaymentAdapter | null {
      return byKind.get(providerKind) ?? null;
    },
    requireAdapter(providerKind: string): PaymentAdapter {
      const adapter = byKind.get(providerKind);
      if (!adapter) {
        throw new Error(`unknown_payment_provider_kind:${providerKind}`);
      }
      return adapter;
    },
    kinds(): readonly string[] {
      return kindsList;
    },
    asCapabilityRegistry(
      overrides?: Readonly<Record<string, CoreCapabilityOverrides>>,
    ): PaymentProviderCapabilityRegistry {
      const projected = new Map<string, PaymentProviderCapabilityDescriptor>();
      for (const [kind, adapter] of byKind) {
        const override = overrides && Object.hasOwn(overrides, kind) ? overrides[kind] : undefined;
        projected.set(kind, toCorePaymentProviderCapability(adapter.capabilities, override));
      }
      return {
        get(providerKind: string): PaymentProviderCapabilityDescriptor | null {
          return projected.get(providerKind) ?? null;
        },
        kinds(): readonly string[] {
          return kindsList;
        },
      };
    },
    railHandoffKinds(providerKind: string): readonly PaymentMethodHandoff["kind"][] {
      const adapter = byKind.get(providerKind);
      if (!adapter) return Object.freeze([]);
      const seen = new Set<PaymentMethodHandoff["kind"]>();
      for (const flow of adapter.capabilities.captureFlows) {
        if (flow.handoff === "redirect" || flow.handoff === "client-confirmed") {
          seen.add(flow.handoff);
        }
      }
      return Object.freeze([...seen]);
    },
    methodPort(providerKind: string): PaymentRepairMethodPort | null {
      return byKind.get(providerKind)?.methodPort ?? null;
    },
    readbackPorts(): Readonly<Record<string, PaymentReadbackPort>> {
      const ports: Record<string, PaymentReadbackPort> = Object.create(null);
      for (const [kind, adapter] of byKind) {
        ports[kind] = adapter.readbackPort;
      }
      return Object.freeze(ports);
    },
  };
}

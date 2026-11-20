interface SettingMetadata {
  readonly key: string;
  readonly domain: string;
  readonly goal: string;
  readonly schemaVersion: number;
}

/** @experimental Domain-owned metadata for settings discovery. */
export type SettingDescriptor =
  | SettingMetadata & {
    readonly kind: "cap" | "invariant";
    readonly runtime: { level: "read-only"; reason: string };
    readonly change: { reference: string };
  }
  | SettingMetadata & {
    readonly kind: "installed" | "code" | "callback";
    readonly runtime: { level: "ready" } | { level: "read-only" | "preview"; reason: string };
    readonly change: { operation: string } | { file: string; symbol: string } | { reference: string };
    readonly schema?: Record<string, unknown> | null;
    readonly rules: readonly {
      code: string;
      path: readonly string[];
      description: string;
    }[];
    readonly examples: readonly { value: unknown; code?: string }[];
    readonly fallback: unknown;
    readonly absentMeans?: { description: string; source: string; value: unknown };
    readonly defaultBasis: { kind: "neutral" | "reference-code" | "reference-live" };
    readonly whyThisDefault: string;
    readonly effect: {
      appliesTo: string;
      frozenOn: readonly string[];
      impact: "money" | "customer-promise" | "operations";
    };
    readonly previewSchema?: Record<string, unknown> | null;
  };

/** @experimental Machine-readable settings refusal. */
export interface SettingRefusal {
  readonly code: string;
  readonly path: readonly string[];
  readonly rule: string;
  readonly hint: string;
  readonly remediation: { retry: boolean; action: string; command: string };
}

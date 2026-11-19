/** @experimental Domain-owned metadata for settings discovery. */
export interface SettingDescriptor {
  readonly key: string;
  readonly domain: string;
  readonly kind: "installed" | "code" | "callback" | "cap" | "invariant";
  readonly goal: string;
  readonly searchTerms?: string;
  readonly schemaVersion: number;
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
  readonly runtime: { level: "ready" } | { level: "read-only" | "preview"; reason: string };
  readonly previewSchema?: Record<string, unknown> | null;
  readonly change: { operation: string } | { file: string; symbol: string } | { reference: string };
}

/** @experimental Machine-readable settings refusal. */
export interface SettingRefusal {
  readonly code: string;
  readonly path: readonly string[];
  readonly rule: string;
  readonly hint: string;
  readonly remediation: { retry: boolean; action: string; command: string };
}

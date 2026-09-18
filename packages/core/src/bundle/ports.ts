/** Opaque, adopter-defined sizing anchor with a minimal discriminator. */
/** @beta */
export interface CompositionConstraint {
  /** Adapter-owned constraint family, for example "fixed.catalog". */
  kind: string;
  /** Adapter-owned schema version for data. */
  version: number;
  /** Adapter-owned payload; core passes it through without inspecting it. */
  data: Record<string, unknown>;
}

/** @beta */
export interface BundleLineRef {
  variantId: string;
  qty: number;
  isAddon: boolean;
}

/** @beta */
export interface CompositionRulesPort {
  validateComposition(input: {
    coreLines: BundleLineRef[];
    addonLines: BundleLineRef[];
    constraint: CompositionConstraint;
  }): Promise<{ ok: true } | { ok: false; code: string; details?: Record<string, unknown> }>;

  resizeComposition(input: {
    coreLines: BundleLineRef[];
    constraint: CompositionConstraint;
    lever: { kind: string; value: unknown };
  }): Promise<{ coreLines: BundleLineRef[]; constraint: CompositionConstraint } | null>;
}

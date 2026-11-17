import { createHash } from "node:crypto";
import {
  canonicalCatalogPriceSetupCommand,
  catalogPriceSetupApplyResultSchema,
  catalogPriceSetupCommandSchema,
  catalogPriceSetupPreviewQuerySchema,
  catalogPriceSetupPreviewResultSchema,
  catalogPriceSetupReceiptSchema,
  type CatalogPriceSetupApplyResult,
  type CatalogPriceSetupPreview,
  type CatalogPriceSetupPreviewQuery,
  type CatalogPriceSetupRefusal,
} from "./catalogPriceSetupSchemas.js";

/** Persistence for the use case. Answers are validated here, never trusted.
 * @experimental
 */
export interface CatalogPriceSetupStorePort {
  preview(query: CatalogPriceSetupPreviewQuery): Promise<unknown>;
  apply(input: { canonicalCommand: string; fingerprint: string }): Promise<unknown>;
}

/** @experimental */
export interface CatalogPriceSetupHandlerDeps<Context> {
  /** Bound to the same administrator's session that `authorizeOperator` verified. */
  store: CatalogPriceSetupStorePort;
  /** The verified administrator's user id, or null when the request carries none. */
  authorizeOperator(context: Context): Promise<{ actorId: string } | null>;
}

/** @experimental */
export type CatalogPriceSetupReadback =
  | { outcome: "confirmed" | "diverged"; preview: CatalogPriceSetupPreview }
  | CatalogPriceSetupRefusal;

const unauthorized = (): CatalogPriceSetupRefusal => ({ outcome: "unauthorized", reason: "operator_required" });
const invalid = (): CatalogPriceSetupRefusal => ({ outcome: "validation_issue", reason: "price_setup_input_invalid" });
const unavailable = (): CatalogPriceSetupRefusal => ({
  outcome: "dependency_unavailable", reason: "price_setup_dependency_unavailable",
});

/** Dark use case: mounting requires a verified administrator authorizer and a session-bound store.
 * @experimental
 */
export function createCatalogPriceSetupHandler<Context>(deps: CatalogPriceSetupHandlerDeps<Context>) {
  async function operator(context: Context): Promise<{ actorId: string } | CatalogPriceSetupRefusal> {
    try {
      const found = await deps.authorizeOperator(context);
      return found && typeof found.actorId === "string" && found.actorId.length > 0 ? found : unauthorized();
    } catch {
      return unavailable();
    }
  }

  async function readPreview(query: CatalogPriceSetupPreviewQuery): Promise<CatalogPriceSetupPreview | CatalogPriceSetupRefusal> {
    try {
      const parsed = catalogPriceSetupPreviewResultSchema.safeParse(await deps.store.preview(query));
      if (!parsed.success) return unavailable();
      const answer = parsed.data;
      if (answer.outcome === "preview" && (answer.variantId !== query.variantId
        || answer.priceListId !== query.priceListId
        || answer.proposed?.unitPriceMinor !== query.unitPriceMinor)) return unavailable();
      return answer;
    } catch {
      return unavailable();
    }
  }

  return {
    async preview(input: unknown, context: Context): Promise<CatalogPriceSetupPreview | CatalogPriceSetupRefusal> {
      const actor = await operator(context);
      if ("outcome" in actor) return actor;
      const query = catalogPriceSetupPreviewQuerySchema.safeParse(input);
      if (!query.success) return invalid();
      return readPreview(query.data);
    },

    async apply(input: unknown, context: Context): Promise<CatalogPriceSetupApplyResult> {
      const actor = await operator(context);
      if ("outcome" in actor) return actor;
      let canonicalCommand: string;
      try {
        canonicalCommand = canonicalCatalogPriceSetupCommand(input);
      } catch {
        return invalid();
      }
      const command = catalogPriceSetupCommandSchema.parse(JSON.parse(canonicalCommand));
      const fingerprint = createHash("sha256").update(canonicalCommand).digest("hex");
      try {
        const parsed = catalogPriceSetupApplyResultSchema.safeParse(
          await deps.store.apply({ canonicalCommand, fingerprint }));
        if (!parsed.success) return unavailable();
        const result = parsed.data;
        // A receipt for another command or another administrator means the store is not
        // bound to this request: fail closed rather than report someone else's write.
        if ((result.outcome === "committed" || result.outcome === "replayed")
          && (result.receipt.commandKey !== command.commandKey
            || result.receipt.variantId !== command.variantId
            || result.receipt.priceListId !== command.priceListId
            || result.receipt.actorId !== actor.actorId
            || result.receipt.current.unitPriceMinor !== command.unitPriceMinor)) return unavailable();
        return result;
      } catch {
        return unavailable();
      }
    },

    /** Confirms that a receipt's base is still the effective one, after a lost response or later. */
    async readback(input: { receipt: unknown }, context: Context): Promise<CatalogPriceSetupReadback> {
      const actor = await operator(context);
      if ("outcome" in actor) return actor;
      const receipt = catalogPriceSetupReceiptSchema.safeParse(input?.receipt);
      if (!receipt.success) return invalid();
      const preview = await readPreview({ variantId: receipt.data.variantId, priceListId: receipt.data.priceListId });
      if (preview.outcome !== "preview") return preview;
      const confirmed = preview.current?.entryId === receipt.data.current.entryId
        && preview.current.unitPriceMinor === receipt.data.current.unitPriceMinor;
      return { outcome: confirmed ? "confirmed" : "diverged", preview };
    },
  };
}

import { z } from "zod";
import { frozenJsonSchema, OPEN_SET_PATTERN, openSet, parseVersionedContract } from "./storefrontVerdictSchema.js";

/**
 * A store's proof file, format version 1: what a storefront proof runs against.
 * Unknown fields are kept; `host` is the only namespace a host may use, and other
 * unknown top-level fields are reserved for later platform fields.
 *
 * Within format version 1 fields are only added. Until the first release that
 * carries the storefront runner, format version 1 may still be amended without a
 * version bump.
 *
 * @experimental
 */
export type StorefrontProofFile = {
  formatVersion: 1;
  /** Configuration ids to prove; at least one. */
  configurations: string[];
  /** Positive integer widths in CSS pixels; at least one. */
  widths: number[];
  /**
   * `surfaces`: a path per surface (`product`, `cart`, `checkout`, `account`;
   * open), without query or fragment. `selectionEntry`: per purchase mode
   * (`one_time`, `subscription`; open) an ordinary route that opens the cart with
   * the first sellable product at its minimum quantity in that mode; it may carry
   * a query, never a fragment. Every path starts with `/`, not `//`, and holds no
   * backslash.
   */
  routes?: { surfaces?: Record<string, string>; selectionEntry?: Record<string, string> };
  /** Action names this UI performs by itself. */
  autoProgress?: string[];
  /** Absent or unknown is read as `refuse_changed`. */
  changedPayloadPolicy?: "update_in_place" | "refuse_changed" | (string & {});
  /** Buyer-detail overrides. `email` is refused: the e-mail carries the run's subject. */
  buyer?: {
    first_name?: string;
    last_name?: string;
    phone?: string;
    address_line1?: string;
    address_line2?: string;
    city?: string;
    postal_code?: string;
    email?: never;
  };
  /** Command that reruns one scenario; `{scenario}` is replaced by the scenario id. */
  recheck?: string;
  /** Relative POSIX path of the optional adapter module: no leading `/`, scheme, backslash, `?`, `#`, `.` or `..` segment. */
  adapterModule?: string;
  /** Fields a host adds, kept as given and never read by the package. */
  host?: Record<string, unknown>;
};

const surfacePath = z.string().regex(/^\/(?:[^/\\?#][^\\?#]*)?$/);
const selectionEntryPath = z.string().regex(/^\/(?:[^/\\#][^\\#]*)?$/);
const SEGMENT = String.raw`(?:[^/\\?#:.][^/\\?#:]*|\.[^/\\?#:.][^/\\?#:]*|\.\.[^/\\?#:]+)`;
const key = z.string().regex(OPEN_SET_PATTERN);

const proofFileSchema = z.looseObject({
  formatVersion: z.literal(1),
  configurations: z.array(z.string().min(1)).min(1),
  widths: z.array(z.number().int().positive()).min(1),
  routes: z.looseObject({
    surfaces: z.record(key, surfacePath).optional(),
    selectionEntry: z.record(key, selectionEntryPath).optional(),
  }).optional(),
  autoProgress: z.array(key).optional(),
  changedPayloadPolicy: openSet(["update_in_place", "refuse_changed"] as const).optional(),
  buyer: z.looseObject({
    first_name: z.string().optional(),
    last_name: z.string().optional(),
    phone: z.string().optional(),
    address_line1: z.string().optional(),
    address_line2: z.string().optional(),
    city: z.string().optional(),
    postal_code: z.string().optional(),
    email: z.never().optional(),
  }).optional(),
  recheck: z.string().min(1).optional(),
  adapterModule: z.string().regex(new RegExp(`^${SEGMENT}(?:/${SEGMENT})*$`)).optional(),
  host: z.looseObject({}).optional(),
});

/**
 * Parses proof-file text: JSON object, `formatVersion`, then the schema. Never
 * throws; unknown fields are kept.
 *
 * @experimental
 */
export function parseStorefrontProofFile(text: string):
  | { ok: true; proofFile: StorefrontProofFile }
  | { ok: false; refusal: { code: "storefront_proof_file_invalid" | "storefront_proof_file_version_unsupported"; observed: string; cause: string; fix: string; recheck: string } } {
  const parsed = parseVersionedContract<StorefrontProofFile, "storefront_proof_file_invalid", "storefront_proof_file_version_unsupported">(
    text,
    { subject: "storefront proof file", invalid: "storefront_proof_file_invalid", unsupported: "storefront_proof_file_version_unsupported", parser: "parseStorefrontProofFile" },
    () => proofFileSchema,
  );
  return parsed.ok ? { ok: true, proofFile: parsed.value } : parsed;
}

/**
 * The proof file's JSON Schema (draft-07), as data. Unknown properties are allowed. Frozen.
 *
 * @experimental
 */
export const storefrontProofFileJsonSchema: Readonly<Record<string, unknown>> = frozenJsonSchema(proofFileSchema);

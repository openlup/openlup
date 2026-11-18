import { createHash } from "node:crypto";
import { z } from "zod";

const digest = z.string().regex(/^[a-f0-9]{64}$/u);
const id = z.guid().refine(value => value === value.toLowerCase());
const code = z.string().min(1).max(80).refine(value => value.trim() === value);
const headSchema = z.object({ protocol: z.enum(["v1", "v2", "v3"]), event_id: id.nullable(),
  event_sequence: z.number().int().positive().nullable(), state_digest: digest.nullable(),
  state_canonical_text: z.string().min(2).max(16_777_216).nullable(),
}).strict().refine(head => head.protocol === "v1"
  ? head.event_id === null && head.event_sequence === null && (head.state_digest === null) === (head.state_canonical_text === null)
  : head.event_id !== null && head.event_sequence !== null && head.state_canonical_text !== null);

const member = z.object({ skuId: id, skuCode: code, productId: id, productSlug: code,
  netWeightG: z.number().int().min(1).max(9_999_999), sellableStandalone: z.boolean(), sellableInSubscription: z.boolean(),
  presentation: z.record(z.string(), z.json()).nullable(), logisticsRef: z.string().min(1).max(500).nullable(),
}).strict();
const querySchema = z.object({ offerVersion: code, mode: z.enum(["one_time", "subscription"]).nullable(),
  cursor: id.nullable(), limit: z.number().int().min(1).max(100),
}).strict();
const pageSchema = z.object({ protocol: z.enum(["v1", "v2", "v3"]), headDigest: digest.nullable(), items: z.array(member).max(100),
  nextCursor: id.nullable(),
}).strict();
const activation = z.object({ protocol: z.literal("v3"), headDigest: digest, items: z.array(z.object({
  skuCode: code, skuId: id.nullable(), ready: z.boolean(), reasons: z.array(z.string().regex(/^[a-z][a-z0-9_]{1,119}$/u)).max(32),
  logisticsRef: z.string().min(1).max(500).refine(value => value.trim() === value).nullable(),
}).strict().refine(item => item.ready === (item.reasons.length === 0)
  && (!item.ready || item.skuId !== null && item.logisticsRef !== null))).max(100) }).strict();
const scopeSchema = z.array(member.omit({ presentation: true, logisticsRef: true })).max(100);
const missingMethod = "Could not find the function public.catalog_offer_memberships_page(p_cursor, p_limit, p_mode, p_offer_version) in the schema cache";
type AuthorityFailure = "response_invalid" | "store_unavailable" | "authority_changed" | "compatibility_identity_mismatch" | "query_invalid";

const refusal = (reason: AuthorityFailure) => ({ outcome: "refused" as const, reason });
const unavailable = () => refusal("store_unavailable");
const invalid = () => refusal("response_invalid");
const sortedUnique = (values: readonly string[]) => values.every((value, index) => index === 0 || values[index - 1]! < value);

type StateValidator = (text: string, protocol: "v1" | "v2" | "v3") => boolean | Promise<boolean>;
async function verifiedHead(protocol: string, rows: unknown, validateState: StateValidator) {
  const head = headSchema.safeParse(Array.isArray(rows) && rows.length === 1 ? rows[0] : null);
  if (!head.success || head.data.protocol !== protocol) return null;
  const { state_canonical_text: text, state_digest: expected, event_id: eventId, event_sequence: sequence } = head.data;
  if (text !== null) {
    if (createHash("sha256").update(text).digest("hex") !== expected) return null;
    try { if (!await validateState(text, head.data.protocol)) return null; } catch { return null; }
  }
  return { protocol: head.data.protocol, headDigest: expected, eventId, sequence };
}
interface ManagedCatalogClient {
  rpc(name: string, input: Record<string, unknown>): PromiseLike<{ data: unknown; error: { code?: string; message?: string } | null }>;
}

/**
 * Map the installed managed protocol in place. The host supplies the exact
 * state grammar and expected identities from its own publication authority.
 * @experimental
 */
export function createManagedCatalogPublicationEvidence(input: {
  client: ManagedCatalogClient;
  validateState: StateValidator;
  expectedMembers(headDigest: string, query: z.infer<typeof querySchema>): Promise<z.infer<typeof scopeSchema>>;
}) {
  const read = async (query: z.input<typeof querySchema>) => {
    const parsed = querySchema.safeParse(query);
    if (!parsed.success) return refusal("query_invalid");
    const request = parsed.data;
    try {
      const observed = await input.client.rpc("catalog_offer_memberships_page", {
        p_offer_version: request.offerVersion, p_mode: request.mode, p_cursor: request.cursor, p_limit: request.limit,
      });
      if (observed.error?.code === "PGRST202" && observed.error.message === missingMethod) {
        const prior = await input.client.rpc("catalog_publication_v2_current_state", {});
        if (prior.error !== null) return unavailable();
        const head = await verifiedHead("v2", prior.data, input.validateState);
        return head ? { outcome: "prior_protocol" as const, head } : invalid();
      }
      if (observed.error !== null) return observed.error.code === "40001" || observed.error.message === "catalog_publication_v3_drift"
        ? refusal("authority_changed") : unavailable();
      const result = pageSchema.safeParse(observed.data);
      if (!result.success) return invalid();
      const page = result.data;
      if (page.protocol !== "v3" && (page.items.length !== 0 || page.nextCursor !== null)) return invalid();
      if (page.protocol !== "v1" && page.headDigest === null) return invalid();
      if (page.items.length > request.limit || !sortedUnique(page.items.map(item => item.skuId))
        || new Set(page.items.map(item => item.skuCode)).size !== page.items.length
        || page.nextCursor !== null && page.nextCursor !== page.items.at(-1)?.skuId
        || page.items.some(item => request.cursor !== null && item.skuId <= request.cursor
          || (request.mode === "one_time" ? !item.sellableStandalone
            : request.mode === "subscription" ? !item.sellableInSubscription : !item.sellableStandalone && !item.sellableInSubscription))) return invalid();

      const response = await input.client.rpc("catalog_publication_v3_current_state", {});
      if (response.error !== null) return unavailable();
      const head = await verifiedHead(page.protocol, response.data, input.validateState);
      if (!head) return invalid();
      if (head.headDigest !== page.headDigest) return refusal("authority_changed");
      if (page.protocol !== "v3" || head.headDigest === null) return { outcome: "prior_protocol" as const, head };

      const expected = scopeSchema.safeParse(await input.expectedMembers(head.headDigest, request));
      if (!expected.success || expected.data.length !== page.items.length || expected.data.some((value, index) => {
        const item = page.items[index]!;
        return value.skuId !== item.skuId || value.skuCode !== item.skuCode || value.productId !== item.productId
          || value.productSlug !== item.productSlug || value.netWeightG !== item.netWeightG
          || value.sellableStandalone !== item.sellableStandalone || value.sellableInSubscription !== item.sellableInSubscription;
      })) return refusal("compatibility_identity_mismatch");
      return { outcome: "verified" as const, head, items: page.items, nextCursor: page.nextCursor };
    } catch {
      return unavailable();
    }
  };
  return Object.assign(read, {
    async activationReadiness(skuCodes: readonly string[], expectedHeadDigest: string) {
      if (skuCodes.length < 1 || skuCodes.length > 100 || new Set(skuCodes).size !== skuCodes.length
        || !skuCodes.every(skuCode => code.safeParse(skuCode).success)
        || !digest.safeParse(expectedHeadDigest).success) return refusal("query_invalid");
      try {
        const response = await input.client.rpc("catalog_publication_v3_activation_readiness", {
          p_sku_codes: [...skuCodes], p_expected_head_digest: expectedHeadDigest,
        });
        if (response.error !== null) return response.error.code === "40001" ? refusal("authority_changed") : unavailable();
        const observed = activation.safeParse(response.data);
        if (!observed.success) return invalid();
        const { headDigest, items } = observed.data;
        if (headDigest !== expectedHeadDigest || items.length !== skuCodes.length
          || items.some((item, index) => item.skuCode !== skuCodes[index])) return refusal("authority_changed");
        return { outcome: "verified" as const, headDigest, items };
      } catch { return unavailable(); }
    },
  });
}

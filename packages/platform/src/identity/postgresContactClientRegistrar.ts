import { z } from "zod";
import { createPostgresRoleFreeTransactionLane, type PgQueryExecutor } from "../data/index.js";

export interface EnsureContactClientInput {
  email: string;
  acquisitionSource: string;
  lifecycleStage: "lead" | "customer" | "inactive";
  profileDefaults?: { firstName?: string | null; lastName?: string | null; phone?: string | null; country?: string | null };
  journey?: { idempotencyKey: string; locale: string; mode: "one_time" | "subscription" };
}

export type EnsureContactClientResult =
  | { ok: true; clientId: string; created: boolean; linked: boolean }
  | { ok: false; code: "contact_client_email_invalid" | "contact_client_input_invalid"
      | "account_erased_refused" };

/** Host-only contact resolution, never authentication. Never expose linked or created
 * to the browser: they would reveal account existence. Keep clientId internal to
 * the host's admitted purchase; it grants no access to existing customer data. */
export interface PostgresContactClientRegistrar {
  ensureContactClient(input: EnsureContactClientInput): Promise<EnsureContactClientResult>;
  close(): Promise<void>;
}

const emailSchema = z.email().max(320);
const inputSchema = z.object({
  email: z.string().max(320),
  acquisitionSource: z.string().max(100).trim().min(1),
  lifecycleStage: z.enum(["lead", "customer", "inactive"]),
  profileDefaults: z.object({
    firstName: z.string().max(80).nullable().optional(),
    lastName: z.string().max(80).nullable().optional(),
    phone: z.string().max(64).nullable().optional(),
    country: z.string().max(2).nullable().optional(),
  }).strict().optional(),
  journey: z.object({
    idempotencyKey: z.string().min(8).max(160),
    locale: z.string().min(1).max(35),
    mode: z.enum(["one_time", "subscription"]),
  }).strict().optional(),
}).strict();
type RefusalCode = Extract<EnsureContactClientResult, { ok: false }>["code"];
class ContactClientRefusal extends Error {
  constructor(readonly code: RefusalCode) { super(code); }
}

/** Ensure an unverified checkout contact; refresh defaults and journey facts only
 * while it remains unlinked. Linked rows are never updated or relinked.
 * The host owns validation, requester quotas, checkout admission and retention.
 * Receipt-bound shells refuse; a freed original email starts a fresh client. */
export function createPostgresContactClientRegistrar(
  env: { connectionString: string },
): PostgresContactClientRegistrar {
  const lane = createPostgresRoleFreeTransactionLane(env);
  return {
    async ensureContactClient(input) {
      const parsed = inputSchema.safeParse(input);
      if (!parsed.success) return { ok: false, code: "contact_client_input_invalid" };
      const email = parsed.data.email.trim().toLowerCase();
      if (!emailSchema.safeParse(email).success) return { ok: false, code: "contact_client_email_invalid" };
      try {
        return await lane.run(async executor => {
          const db = executor as PgQueryExecutor;
          await db.query("SET TRANSACTION ISOLATION LEVEL READ COMMITTED");
          await db.query("SET LOCAL lock_timeout = '5s'");
          await db.query("SET LOCAL statement_timeout = '15s'");
          // Same receipt-before-contact discipline as account linking and erasure.
          await db.query("LOCK TABLE public.identity_privacy_erasures IN SHARE MODE");
          const read = async () => {
            const { rows } = await db.query(`SELECT c.id, c.principal_id,
              EXISTS (SELECT 1 FROM public.identity_privacy_erasures e
                WHERE e.client_id = c.id OR e.principal_id = c.principal_id) AS erased
              FROM public.clients c WHERE lower(c.email) = $1 LIMIT 1`, [email]);
            if (rows.some(row => row.erased)) throw new ContactClientRefusal("account_erased_refused");
            return rows[0];
          };
          const refresh = async (id: unknown, created: boolean) => {
            const profile = parsed.data.profileDefaults, journey = parsed.data.journey;
            const metadata = journey ? { checkout: { lastIntentIdempotencyKey: journey.idempotencyKey,
              locale: journey.locale, mode: journey.mode, clientMatchReason: created ? "client_created" : "client_match_exact_email" } } : {};
            // Profile defaults replace prior defaults only on an unlinked contact;
            // empty input never erases an existing value. The predicate is the race fence.
            await db.query(`UPDATE public.clients SET
              first_name = CASE WHEN $2 THEN $3::text ELSE COALESCE(NULLIF($3::text, ''), first_name) END,
              last_name = CASE WHEN $2 THEN $4::text ELSE COALESCE(NULLIF($4::text, ''), last_name) END,
              phone = CASE WHEN $2 THEN $5::text ELSE COALESCE(NULLIF($5::text, ''), phone) END,
              country = CASE WHEN $2 THEN $6::text ELSE COALESCE(NULLIF($6::text, ''), country) END,
              updated_at = now(), metadata = CASE WHEN $7::jsonb = '{}'::jsonb THEN metadata ELSE metadata || $7::jsonb END
              WHERE id = $1 AND principal_id IS NULL`,
            [id, created, profile?.firstName ?? null, profile?.lastName ?? null, profile?.phone ?? null,
              profile?.country ?? null, JSON.stringify(metadata)]);
          };
          const existing = await read();
          const inserted = existing ? { rows: [] } : await db.query(`INSERT INTO public.clients
            (email, principal_id, acquisition_source, lifecycle_stage) VALUES ($1, NULL, $2, $3)
            ON CONFLICT (lower(email)) DO NOTHING RETURNING id`,
          [email, parsed.data.acquisitionSource, parsed.data.lifecycleStage]);
          // A separate READ COMMITTED statement observes the concurrent winner.
          // A refusal here throws so even our insert is rolled back.
          const contact = await read();
          if (!contact) throw new Error("contact_client_unresolved");
          const created = inserted.rows.length === 1;
          if (contact.principal_id === null) await refresh(contact.id, created);
          const current = await read();
          if (!current) throw new Error("contact_client_unresolved");
          return { ok: true as const, clientId: String(current.id), created, linked: current.principal_id !== null };
        });
      } catch (error) {
        if (error instanceof ContactClientRefusal) return { ok: false, code: error.code };
        throw error;
      }
    },
    close: lane.close,
  };
}

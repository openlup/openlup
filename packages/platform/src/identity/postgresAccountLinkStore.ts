import { createPostgresRoleFreeTransactionLane, type PgQueryExecutor } from "../data/index.js";
import type { AccountLinkStore, CustomerAccount } from "./ports.js";
/** Trusted contact-link capability; conditional writes never replace an existing principal. */
export function createPostgresAccountLinkStore(env: { connectionString: string }): AccountLinkStore & { close(): Promise<void> } {
  const lane = createPostgresRoleFreeTransactionLane(env);
  const run = <T>(work: (db: PgQueryExecutor) => Promise<T>) => lane.run(db => work(db as PgQueryExecutor));
  const account = (row: Record<string, unknown> | undefined): CustomerAccount | null => row
    ? { id: String(row.id), email: row.email === null ? null : String(row.email), principalId: row.principal_id === null ? null : String(row.principal_id) } : null;
  async function writable(db: PgQueryExecutor, principalId: string, clientId: string | null = null) {
    // Same receipt-before-contact lock order as privacy erasure; no concurrent resurrection.
    await db.query("LOCK TABLE public.identity_privacy_erasures IN SHARE MODE");
    if ((await db.query("SELECT 1 FROM public.identity_privacy_erasures WHERE principal_id = $1 OR client_id = $2 LIMIT 1", [principalId, clientId])).rows.length) throw new Error("account_erased_refused");
  }
  return {
    findAccountByPrincipalId(id) {
      return run(async db => account((await db.query("SELECT id, email, principal_id FROM public.clients WHERE principal_id = $1", [id])).rows[0]));
    },
    findAccountByEmail(email) {
      return run(async db => {
        const rows = (await db.query("SELECT id, email, principal_id FROM public.clients WHERE lower(btrim(email)) = $1 LIMIT 2", [email.trim().toLowerCase()])).rows;
        if (rows.length > 1) throw new Error("account_normalized_email_ambiguous");
        return account(rows[0]);
      });
    },
    isReservedPrincipal(id) {
      return run(async db => (await db.query("SELECT 1 FROM public.platform_control_operators WHERE principal_id = $1 UNION ALL SELECT 1 FROM public.identity_privacy_erasures WHERE principal_id = $1 LIMIT 1", [id])).rows.length > 0);
    },
    linkPrincipalToAccount(id, principalId) {
      return run(async db => {
        await writable(db, principalId, id);
        const updated = await db.query("UPDATE public.clients SET principal_id = $2 WHERE id = $1 AND principal_id IS NULL RETURNING id", [id, principalId]);
        if (updated.rows.length) return { ok: true, alreadyLinked: false };
        const row = (await db.query("SELECT principal_id FROM public.clients WHERE id = $1", [id])).rows[0];
        return row?.principal_id === principalId ? { ok: true, alreadyLinked: true }
          : { ok: false, existingPrincipalId: row?.principal_id == null ? null : String(row.principal_id) };
      });
    },
    createAccount(input) {
      return run(async db => {
        await writable(db, input.principalId);
        const row = (await db.query(`INSERT INTO public.clients (email, principal_id, acquisition_source, lifecycle_stage)
          VALUES ($1, $2, $3, $4) RETURNING id`, [input.email, input.principalId, input.acquisitionSource, input.lifecycleStage])).rows[0];
        if (!row) throw new Error("account_insert_failed");
        return { id: String(row.id) };
      });
    },
    close: lane.close,
  };
}

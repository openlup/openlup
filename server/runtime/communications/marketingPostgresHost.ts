import { createHash } from "node:crypto";
import type { PgQueryExecutor } from "@openlup/platform/data";
import type { A1HostInputs } from "./a1ReferenceBinding.js";

type MarketingStorage = A1HostInputs["marketing"]["storage"];
type Journal = Record<string, unknown> & {
  version: 1; slot: boolean; quarantined: boolean; coolingUntil: number; nextAt: number;
  entries: Record<string, { phase: string; result?: { kind?: string; journal?: string } }>;
};

/** Explicit application-owned setup, run by its owner before composition, never at startup.
 * The owner supplies its runtime-role grants, privacy contributor and retention disposition.
 * This is not a platform migration or a qualified production installation. */
export const marketingPostgresHostSetup = `CREATE SCHEMA IF NOT EXISTS app;
CREATE TABLE app.communication_marketing_journal (
  account text NOT NULL,
  environment text NOT NULL,
  value text NOT NULL,
  PRIMARY KEY (account, environment)
);
REVOKE ALL ON app.communication_marketing_journal FROM PUBLIC;`;

function object(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
function journal(raw: string): Journal {
  const value: unknown = JSON.parse(raw);
  if (!object(value) || value.version !== 1 || typeof value.slot !== "boolean" || typeof value.quarantined !== "boolean" ||
    !Number.isFinite(value.coolingUntil) || !Number.isFinite(value.nextAt) || !object(value.entries) || !object(value.mappings) ||
    !Array.isArray(value.tombstones) || !object(value.withdrawals) || Object.values(value.entries).some(entry =>
      !object(entry) || !["admitted", "dispatched", "settled"].includes(String(entry.phase)) ||
      entry.result !== undefined && !object(entry.result))) throw new Error("marketing_host_journal_invalid");
  // This validates the recovery carrier only. The adapter validates every unchanged private entry.
  return value as Journal;
}
const fingerprint = (raw: string | null) => createHash("sha256").update(raw === null ? "absent" : `text:${raw}`).digest("hex");
function unsettled(value: Journal): string[] {
  return Object.entries(value.entries).filter(([, entry]) => entry.phase !== "settled" ||
    entry.result?.kind === "unknown" || entry.result?.journal === "unknown").map(([key]) => key).sort();
}

/** M2 reference host: durable exact-byte CAS and explicit recovery for one Node process.
 * Share this ONE storage object across every namespace/adapter for the account/environment.
 * Selecting this profile does not prove cross-process exclusion; multiple Node processes are unsupported.
 * The caller owns database connection lifetime and must stop all old adapter work before recovery.
 *
 * v1 retains original requests/targets, including PII, to preserve replay and receipt provenance.
 * There is no supported history compaction or erasure here: the host must register a truthful
 * retain disposition before using personal data. Do not delete entries or replace them with hashes.
 * The caller sets a measured finite size budget; exceeding it closes admission through normal
 * storage-failure handling. Recovery snapshots are privileged PII, never diagnostic log content.
 */
export function createMarketingPostgresHost(input: {
  database: PgQueryExecutor; account: string; environment: string;
  profile: "single-process"; maxJournalBytes: number;
}) {
  if (input.profile !== "single-process") throw new Error("marketing_host_single_process_required");
  if (![input.account, input.environment].every(value => typeof value === "string" && value.trim().length > 0 && value.length <= 512) ||
    !Number.isSafeInteger(input.maxJournalBytes) || input.maxJournalBytes < 1) throw new Error("marketing_host_configuration_invalid");
  const account = input.account, environment = input.environment;
  const accountKey = JSON.stringify(["communications-adapter", account, environment]);
  const availability: MarketingStorage["availability"] = { account, environment, busy: false, quarantined: true };
  const checkKey = (key: string) => { if (key !== accountKey) throw new Error("marketing_host_account_key_mismatch"); };
  const checkBytes = (value: string) => {
    if (typeof value !== "string" || Buffer.byteLength(value, "utf8") > input.maxJournalBytes) throw new Error("marketing_host_journal_budget");
  };
  async function read(): Promise<string | null> {
    const rows = (await input.database.query("SELECT value FROM app.communication_marketing_journal WHERE account=$1 AND environment=$2", [account, environment])).rows;
    if (rows.length === 0) return null;
    if (rows.length !== 1 || typeof rows[0].value !== "string") throw new Error("marketing_host_journal_invalid");
    checkBytes(rows[0].value);
    return rows[0].value;
  }
  const storage: MarketingStorage = {
    availability,
    async get(key) { checkKey(key); return read(); },
    async compareAndSwap(key, expected, value) {
      checkKey(key); checkBytes(value);
      const result = expected === null
        ? await input.database.query(`INSERT INTO app.communication_marketing_journal(account,environment,value)
            VALUES ($1,$2,$3) ON CONFLICT (account,environment) DO NOTHING RETURNING account`, [account, environment, value])
        : await input.database.query(`UPDATE app.communication_marketing_journal SET value=$3
            WHERE account=$1 AND environment=$2 AND value=$4 RETURNING account`, [account, environment, value, expected]);
      // No catch: a thrown reply may follow a committed write; false proves a non-write only.
      return result.rows.length === 1;
    },
  };
  return {
    storage,
    /** Private operator snapshot; its digest can be recorded without logging customer payloads. */
    async recoverySnapshot() {
      const raw = await read(), parsed = raw === null ? undefined : journal(raw);
      return { raw, fingerprint: fingerprint(raw), unsettledEntryKeys: parsed ? unsettled(parsed) : [],
        bytes: raw === null ? 0 : Buffer.byteLength(raw, "utf8"), entries: parsed ? Object.keys(parsed.entries).length : 0 };
    },
    /** The host's authenticated operator has reconciled this exact snapshot and quiesced its old
     * process/adapter work. Retaining unresolved entries records uncertainty; it is not provider
     * settlement. Reconstruct adapters after success; never continue an old in-flight operation. */
    async reconcile(input: { quiesced: true; expected: string | null; reviewedUnsettledEntryKeys: readonly string[]; evidenceReference: string }) {
      availability.quarantined = true;
      if (input.quiesced !== true || availability.busy) throw new Error("marketing_host_quiescence_required");
      if (!input.evidenceReference.trim() || input.evidenceReference.length > 512) throw new Error("marketing_host_recovery_evidence_required");
      availability.busy = true;
      try {
        const raw = await read();
        if (raw !== input.expected) throw new Error("marketing_host_recovery_conflict");
        const parsed = raw === null ? undefined : journal(raw), pending = parsed ? unsettled(parsed) : [];
        if (JSON.stringify([...input.reviewedUnsettledEntryKeys].sort()) !== JSON.stringify(pending)) throw new Error("marketing_host_unreconciled_entries");
        if (parsed) {
          // Preserve all evidence and fences byte-for-byte as JSON values; never change a result,
          // grant settlement, cooldown, generation or replay identity during local recovery.
          const repaired = JSON.stringify({ ...parsed, slot: false, quarantined: false });
          if (!await storage.compareAndSwap(accountKey, raw, repaired) || await read() !== repaired) throw new Error("marketing_host_recovery_uncertain");
        }
        availability.quarantined = false;
        return { fingerprint: fingerprint(raw), unresolvedEntries: pending.length, evidenceReference: input.evidenceReference };
      } finally { availability.busy = false; }
    },
  };
}

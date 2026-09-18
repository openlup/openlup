/**
 * BORN PENDING — rule (e) of the PR-time provisioning gate. It lives beside
 * check-new-key-provisioning.ts, which imports it and owns the CLI; this module is
 * not a separate gate and has no npm script, workflow step or verify stage of its
 * own. It was split out because the host file sits at its 300-line cap, so the whole
 * rule plus its rationale would not fit there without an override on a shrink-only
 * ratchet.
 *
 * On 2026-08-21 PR 2957 added one routing row to config/secrets-map.json and
 * provisioned no value. scripts/secrets/verify-drift.ts turns a mapped-but-absent
 * consumer into `level: "error"` and exits 1 on any error, with NO scope filter, and
 * `npm run secrets:verify` is the hard "Secret drift gate" step of
 * .github/workflows/release-production.yml. That single preview-scope row blocked
 * four production releases across two days while production itself was clean.
 *
 * The same file already routes a row carrying `pending: true` to a WARNING instead,
 * and 8 of the 52 mapped rows use it. So: a row that is NEW against the merge base
 * must be born with that marker. A row that already existed at the base is not this
 * rule's business, and clearing a marker — the graduation path,
 * `npm run secrets:verify-prod-presence -- --fix` — stays allowed.
 */

const SECRETS_MAP = "config/secrets-map.json";

/**
 * The ONE native store in config/secrets-map.json whose `pending: true` marker
 * changes what `npm run secrets:verify` does. Its arm of verify-drift sorts absent
 * consumers into `want` (error, exits 1) and `pending` (warning). The GitHub arm of
 * the same function has no pending branch at all — an absent mapped GitHub secret is
 * an error whether or not it is marked — so demanding the marker there would demand
 * a remedy that does not exist. The two "invisible" stores degrade to a warning in
 * the release job, which passes no credentials for either, so neither can cause the
 * incident. Widening this constant without first giving that store a pending branch
 * in verify-drift would block work with no way to unblock it.
 */
export const PENDING_CAPABLE_STORE = "vercel";

export type MapConsumer = {
  store: string;
  secret: string;
  scope: string;
  name: string;
  pending: boolean;
  bornProvisioned: string;
};

/** Structurally assignable to the host guard's NewKeyViolation, without importing it back. */
export type SecretConsumerViolation = { kind: "secret-consumer"; key: string; message: string };

/** Stable identity of a routing row: a rename or a re-scope reads as a NEW row, because it is. */
const consumerId = (row: MapConsumer): string => [row.secret, row.store, row.scope, row.name].join("\u0000");

/** Rows of the pending-capable store, keyed by identity. Malformed rows are ignored, not guessed at. */
export function readPendingCapableConsumers(secretsMap: unknown): Map<string, MapConsumer> {
  const out = new Map<string, MapConsumer>();
  const secrets = (secretsMap as { secrets?: Record<string, { consumers?: Record<string, unknown> }> })?.secrets ?? {};
  for (const [secret, routing] of Object.entries(secrets)) {
    for (const [store, rows] of Object.entries(routing?.consumers ?? {})) {
      if (store !== PENDING_CAPABLE_STORE || !Array.isArray(rows)) continue;
      for (const raw of rows as Array<Record<string, unknown>>) {
        if (typeof raw?.name !== "string") continue;
        const row: MapConsumer = {
          store,
          secret,
          scope: typeof raw.scope === "string" ? raw.scope : "(no scope)",
          name: raw.name,
          pending: raw.pending === true,
          bornProvisioned: typeof raw.bornProvisioned === "string" ? raw.bornProvisioned.trim() : "",
        };
        out.set(consumerId(row), row);
      }
    }
  }
  return out;
}

/**
 * A row present at head but absent at base must carry `pending: true`, OR an explicit
 * written `bornProvisioned` reason — the justified-deviation path, reported LOUDLY
 * rather than silently. Marking an ALREADY-LIVE value pending is not the right answer:
 * a stale marker downgrades the production rollout gate from FAIL to WARN
 * (docs/SECRETS.md), so that case needs the declaration, not a false marker.
 */
export function evaluateNewSecretConsumers(
  base: Map<string, MapConsumer>,
  head: Map<string, MapConsumer>,
): { violations: SecretConsumerViolation[]; overrides: string[] } {
  const violations: SecretConsumerViolation[] = [];
  const overrides: string[] = [];
  for (const [id, row] of head) {
    if (base.has(id)) continue;
    const where = `'${row.name}' (secret ${row.secret}, store ${row.store}, scope ${row.scope})`;
    if (row.bornProvisioned) {
      overrides.push(`${where} is born non-pending by declaration: ${row.bornProvisioned}`);
      continue;
    }
    if (row.pending) continue;
    violations.push({
      kind: "secret-consumer",
      key: row.name,
      message:
        `new consumer ${where} has no "pending": true marker. Until the value exists in the store, ` +
        `that row is a hard error in \`npm run secrets:verify\` — the release workflow's Secret drift gate — ` +
        `and it blocks EVERY production release regardless of scope. Do this, in order: ` +
        `(1) add "pending": true to the row now, so the drift gate reports a warning instead of an error; ` +
        `(2) have an operator provision the value (preview the targets with ` +
        `\`npm run secrets:sync:${row.store} -- --only=${row.secret} --scope=${row.scope}\`, which is dry-run by ` +
        `default; the write itself is the operator step in docs/SECRETS.md); ` +
        `(3) graduate the row with \`npm run secrets:verify-prod-presence -- --fix\` once a names-only readback ` +
        `shows the name live, then confirm with \`npm run secrets:verify\`. ` +
        `If the value is ALREADY live, do NOT mark it pending — a stale marker downgrades the production ` +
        `rollout gate from FAIL to WARN. Put \`"bornProvisioned": "<reason + readback date>"\` on the row instead.`,
    });
  }
  return { violations, overrides };
}

/**
 * The impure edge: read the map at both ends of the diff, evaluate, and report.
 * Git access is injected so the pure half above stays the thing under test.
 * A base whose map cannot be read would make every mapped row look new, so that is
 * reported as an unresolved base rather than as ~50 invented violations.
 */
export function bornPendingConsumerFindings(io: {
  base: string;
  head: string | null;
  showAtRef: (ref: string, path: string) => string | null;
  readWorking: (path: string) => string | null;
}): SecretConsumerViolation[] {
  const parse = (text: string | null): unknown => {
    if (!text) return {};
    try {
      return JSON.parse(text);
    } catch {
      return {};
    }
  };
  const baseText = io.showAtRef(io.base, SECRETS_MAP);
  if (baseText == null) {
    console.warn(`born-pending consumer check SKIPPED: ${SECRETS_MAP} could not be read at base ${io.base}.`);
    return [];
  }
  const baseConsumers = readPendingCapableConsumers(parse(baseText));
  const headConsumers = readPendingCapableConsumers(
    parse(io.head ? io.showAtRef(io.head, SECRETS_MAP) : io.readWorking(SECRETS_MAP)),
  );
  const { violations, overrides } = evaluateNewSecretConsumers(baseConsumers, headConsumers);
  for (const line of overrides) console.warn(`OVERRIDE: ${line}`);
  const added = [...headConsumers.keys()].filter((id) => !baseConsumers.has(id)).length;
  console.log(`born-pending consumer check: ${added} new routing row(s) vs ${io.base}, ${overrides.length} declared override(s).`);
  return violations;
}

// One owned old executor for the local handover witness; never an application
// launcher. Imports the actual built package from this worktree's dependencies.
import { randomUUID } from "node:crypto";
import assert from "node:assert/strict";
import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { setTimeout as delay } from "node:timers/promises";
import { Pool } from "pg";
import { createPostgresFulfillmentDispatchStore, runFulfillmentDispatchWorker } from "@openlup/platform/fulfillment";

const input = JSON.parse(readFileSync("/control/input.json", "utf8")), boot = randomUUID();
function status(value) {
  writeFileSync("/control/status.next", JSON.stringify({ boot, uid: process.getuid(), gid: process.getgid(), ...value }), { mode: 0o600 });
  renameSync("/control/status.next", "/control/status.json");
}
status({ phase: "starting" });
const pool = new Pool({ connectionString: input.connectionString, application_name: `m14-dispatch:${boot}`,
  connectionTimeoutMillis: 2000, statement_timeout: 2000, query_timeout: 2000 });
try {
  const url = new URL(input.connectionString);
  assert.equal(url.hostname, "source-db"); assert.equal(url.port, "5432");
  assert.equal(decodeURIComponent(url.username), input.runtimeLogin);
  const identity = (await pool.query(`SELECT current_user,session_user,r.rolsuper,r.rolbypassrls,
    NOT EXISTS(SELECT 1 FROM pg_catalog.pg_class c WHERE c.oid=ANY($1::regclass[])
      AND pg_catalog.pg_has_role(current_user,c.relowner,'USAGE')) AS nonowner
    FROM pg_catalog.pg_roles r WHERE r.rolname=current_user`,
  [["public.fulfillment_dispatch_refs", "public.fulfillment_dispatch_contexts"]])).rows;
  assert.deepEqual(identity, [{ current_user: input.runtimeLogin, session_user: input.runtimeLogin,
    rolsuper: false, rolbypassrls: false, nonowner: true }]);
  const auth = await fetch("http://provider:8080/oauth/auth", { signal: AbortSignal.timeout(2000) });
  if (!auth.ok) throw new Error("fixture_auth_failed");
  const token = (await auth.json()).access_token;
  const store = createPostgresFulfillmentDispatchStore(pool, {
    prepare: async () => ({ disposition: "ready", contactRevision: input.candidate.contactRevision.revision }),
    readCandidate: async () => input.candidate,
  });
  const result = await runFulfillmentDispatchWorker({ store,
    provider: {
      prepare: async () => ({ kind: "prepared", evidence: input.evidence }),
      async dispatch() {
        // The real store.begin already committed submitting. This pause is after
        // local admission and cached authentication, before the actual socket.
        status({ phase: "admitted", credentialCached: true, runtimeIdentity: identity[0] });
        // Older-snapshot mode measures a real 60s age before releasing effects.
        const deadline = Date.now() + (input.olderSnapshot === true ? 63_000 : 30_000);
        while (!existsSync("/control/release")) {
          if (Date.now() >= deadline) throw new Error("fixture_release_deadline");
          await delay(25);
        }
        // Network isolation is not a filesystem writer seal. The final capture
        // must wait for host retirement of this process too.
        writeFileSync(`/source-objects/${input.name}.txt`, `source-write:${boot}`, { mode: 0o600 });
        await fetch("http://provider:8080/effects", { method: "POST",
          headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
          body: input.command, signal: AbortSignal.timeout(5000) });
        throw new Error("fixture_provider_must_drop_ack");
      },
    },
    listCandidates: async () => [input.candidate], config: { mode: "live", batchLimit: 1 },
    keys: { request: value => value.requestKey, mappedAttempt: key => `mapped:${key}`,
      acceptance: ref => ({ providerAttemptKey: `accepted:${ref}`, labelKey: `receipt:${ref}` }) },
  });
  status({ phase: "completed", result });
} catch {
  // No raw URL, connection string, credentials or transport error is emitted.
  status({ phase: "failed" });
} finally {
  await pool.end();
}
// Preserve the exact old container for the explicit restart/retirement probes.
setInterval(() => {}, 1000);

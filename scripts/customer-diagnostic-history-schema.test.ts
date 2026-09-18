import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

const managed = readFileSync("supabase/migrations/20260913120000_customer_diagnostic_coverage_v2.sql", "utf8");
const portable = readFileSync("db/platform/migrations/20260913120000_customer_diagnostic_coverage_v2.sql", "utf8");
const overviewManaged = readFileSync("supabase/migrations/20260913125000_customer_diagnostic_overview_v2.sql", "utf8");
const overviewPortable = readFileSync("db/platform/migrations/20260913125000_customer_diagnostic_overview_v2.sql", "utf8");
const identityManaged = readFileSync("supabase/migrations/20260914120000_customer_diagnostic_ingress_identity.sql", "utf8");
const identityPortable = readFileSync("db/platform/migrations/20260914120000_customer_diagnostic_ingress_identity.sql", "utf8");
const legacy = readFileSync("supabase/migrations/20260912190000_customer_diagnostic_history.sql", "utf8");
const pruneManaged = readFileSync("supabase/migrations/20260914130000_customer_diagnostic_prune_job.sql", "utf8");
const prunePortable = readFileSync("db/platform/migrations/20260914130000_customer_diagnostic_prune_job.sql", "utf8");
// The three shapes the closed reference vocabulary admits are authored in TypeScript;
// the SQL must carry those exact sources, or the route accepts what the table rejects.
const reporter = readFileSync("src/lib/diagnostics/customerJourneyReporter.ts", "utf8");
const observedRequestId = readFileSync("server/_lib/observability/requestId.ts", "utf8");
const hostedProvenance = readFileSync("server/adapters/vercel/runtimeProvenance.ts", "utf8");
const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8")) as {
  forward: Array<{ file: string; sha256: string }>;
};
const rpcCatalog = JSON.parse(readFileSync("config/supabase-rpc-catalog.json", "utf8")) as {
  groups: Array<{ name: string; match: string[]; securityDefinerExpected: boolean }>;
};
const paymentProducer = readFileSync("src/lib/diagnostics/customerJourneyPaymentProducer.ts", "utf8");
describe("customer diagnostic history database contract", () => {
  it("keeps SQL behavior identical with only the runtime-specific service-role grants differing", () => {
    expect(normalizeAuthority(portable)).toBe(normalizeAuthority(managed));
    expect(managed).toContain("TO service_role");
    expect(portable).not.toContain("service_role");
  });

  it("keeps overview behavior identical with only the managed execution grant differing", () => {
    expect(normalizeAuthority(overviewPortable)).toBe(normalizeAuthority(overviewManaged));
    expect(overviewManaged).toContain("TO service_role");
    expect(overviewPortable).not.toContain("service_role");
  });

  it("installs the bounded overview access and index without validating historical rows", () => {
    expect(overviewManaged).toContain("SET LOCAL lock_timeout = '5s'");
    expect(overviewManaged).toContain("SET LOCAL statement_timeout = '30s'");
    expect(overviewManaged).toContain("SET lock_timeout = '5s'");
    expect(overviewManaged).toContain("SET statement_timeout = '30s'");
    expect(overviewManaged).toContain("RESET lock_timeout");
    expect(overviewManaged).toContain("RESET statement_timeout");
    expect(overviewManaged).toContain("DROP CONSTRAINT customer_diagnostic_access_events_operation_check");
    expect(overviewManaged).toContain("CHECK (operation IN ('search','history','overview')) NOT VALID");
    expect(overviewManaged).not.toContain("VALIDATE CONSTRAINT customer_diagnostic_access_events_operation_check");
    expect(overviewManaged).toContain("CREATE INDEX customer_diagnostic_events_overview_idx");
    expect(overviewManaged).toContain("received_at, coverage_version, action, phase, action_id, segment_id");
    expect(overviewManaged).toContain("INCLUDE (code, expires_at)");
  });

  it("computes overview lifecycle rates from distinct action state instead of raw events", () => {
    const overview = functionBody("customer_diagnostic_overview_v2", overviewManaged);
    expect(overview).toContain("p_to - p_from > interval '7 days'");
    expect(overview).toContain("p_page_size NOT BETWEEN 1 AND 25");
    expect(overview).toContain("GROUP BY p.coverage_version, p.action, e.action_id");
    expect(overview).toContain("array_agg(e.segment_id::text ORDER BY e.received_at DESC, e.segment_id DESC)");
    expect(overview).toContain("count(DISTINCT COALESCE(e.code, 'unknown'))");
    expect(overview).toContain("'account_refresh'");
    expect(overview).toContain("'refresh_started'");
    expect(overview).toContain("'refresh_settled'");
    expect(overview).toContain("'observation_gap'");
    expect(overview).toContain("'conflicting_terminal'");
    expect(overview).toContain("'terminalWithoutStart'");
    // The example lists are one pre-aggregate plus one grouped slice, never a
    // correlated subquery re-scanning a materialized CTE per emitted bucket.
    expect(overview).not.toContain("e.id DESC");
    expect(overview).not.toContain("LIMIT 3");
    expect(overview).not.toContain("FROM classified_actions c");
    expect(overview).toContain("(array_agg(x.segment_id ORDER BY x.last_seen_at DESC, x.segment_id DESC))[1:3]");
    expect(overview.split("(array_agg(x.segment_id ORDER BY x.last_seen_at DESC, x.segment_id DESC))[1:3]"))
      .toHaveLength(3);
    expect(overview).toContain("NULLIF(count(DISTINCT e.action_id), 0)::integer AS action_count");
    expect(overview).toContain("'actionCount', s.action_count");
    // A SET clause on the function would not re-arm the running statement's timer.
    expect(overview).not.toContain("statement_timeout");
  });

  it("declares the observation-only action list once and reads it everywhere", () => {
    const overview = functionBody("customer_diagnostic_overview_v2", overviewManaged);
    const declared = overview.match(/v_static_actions text\[\] := ARRAY\[([\s\S]*?)\];/);
    expect(declared).not.toBeNull();
    const staticActions = [...(declared?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    // The literal appears exactly once; every branch reads the variable instead.
    expect(overview.split("'entry_boot'")).toHaveLength(2);
    expect(overview).toContain("p.action <> ALL (v_static_actions)");
    expect(overview).toContain("p.action = ANY (v_static_actions)");
    expect(overview.split("= ANY (v_static_actions)")).toHaveLength(7);
    expect(staticActions).toHaveLength(8);
    // The inventory-derived proof of this set lives in the withheld
    // .agents/contracts/customer-diagnostic-coverage.test.ts, which may read the inventory.
  });

  it("names the two payment actions as producer-convention static, not CHECK-enforced", () => {
    const ingest = functionBody("customer_diagnostic_ingest_v2");
    const genericBranch = ingest.slice(ingest.indexOf("(p_action NOT IN ('entry_boot'"));
    const exclusion = genericBranch.slice(0, genericBranch.indexOf(")"));
    // Six of the eight static actions cannot produce an attempted row at all:
    // the ingest CHECK gives each its own branch and excludes it from the catch-all.
    const checkEnforced = [
      "entry_boot", "entry_hydration", "route_render",
      "configurator_enter", "auth_bootstrap", "auth_callback",
    ];
    for (const action of checkEnforced) {
      expect(ingest).toContain(`(p_action = '${action}' AND `);
      expect(exclusion).toContain(`'${action}'`);
    }
    // These two reach the catch-all branch, which would accept phase 'attempted'.
    // They are settled-only by producer convention:
    // src/lib/diagnostics/customerJourneyPaymentProducer.ts hard-codes phase "settled".
    const conventionStatic = ["payment_confirm", "payment_status"];
    for (const action of conventionStatic) {
      expect(ingest).not.toContain(`(p_action = '${action}' AND `);
      expect(exclusion).not.toContain(`'${action}'`);
      expect(paymentProducer).toContain(`"${action}"`);
    }
    expect(paymentProducer).toContain('phase: "settled" as const');

    const overview = functionBody("customer_diagnostic_overview_v2", overviewManaged);
    const declared = overview.match(/v_static_actions text\[\] := ARRAY\[([\s\S]*?)\];/);
    const staticActions = [...(declared?.[1] ?? "").matchAll(/'([a-z_]+)'/g)].map((match) => match[1]);
    expect([...staticActions].sort()).toEqual([...checkEnforced, ...conventionStatic].sort());
  });

  it("keys and includes every column the matching CTE reads on the overview index", () => {
    const overview = functionBody("customer_diagnostic_overview_v2", overviewManaged);
    const matching = overview.match(/WITH matching AS MATERIALIZED \(\s*SELECT ([\s\S]*?)\s+FROM public\.customer_diagnostic_events e/);
    expect(matching).not.toBeNull();
    const readColumns = [...(matching?.[1] ?? "").matchAll(/\be\.([a-z_]+)/g)].map((match) => match[1]);
    const index = overviewManaged.match(/CREATE INDEX customer_diagnostic_events_overview_idx[\s\S]*?\(([\s\S]*?)\) INCLUDE \(([^)]*)\);/);
    expect(index).not.toBeNull();
    const indexed = new Set(`${index?.[1]},${index?.[2]}`.split(",").map((column) => column.trim()).filter(Boolean));
    expect(readColumns.length).toBeGreaterThan(0);
    for (const column of readColumns) expect(indexed.has(column), column).toBe(true);
    expect(indexed.has("id")).toBe(false);
  });

  it("states this migration's own delta without claiming a covering index", () => {
    const header = overviewManaged.slice(0, overviewManaged.indexOf("\n\n"));
    expect(header).not.toContain("covering");
    expect(header).toContain("customer_diagnostic_events_overview_idx");
    expect(header).toContain(
      "Session-level SET/RESET repeat the SET LOCAL timeouts because the shadow replay lane applies each",
    );
    expect(header).toContain("migration file in autocommit while `supabase db push` wraps the same file in one transaction.");
    expect(overviewPortable).toContain("-- migration:allow-grant: ");
    expect(overviewManaged).toContain("-- migration:allow-grant: ");
  });

  it("keeps overview authorization, availability axes and audit fail-closed", () => {
    const overview = functionBody("customer_diagnostic_overview_v2", overviewManaged);
    expect(overview).toContain("SECURITY INVOKER");
    expect(overview).toContain("SET search_path = pg_catalog");
    expect(overview.indexOf("communications_require_active_operator"))
      .toBeLessThan(overview.indexOf("IF p_from IS NULL"));
    expect(overview.indexOf("INSERT INTO public.customer_diagnostic_access_events"))
      .toBeLessThan(overview.lastIndexOf("RETURN"));
    for (const fragment of ["'windowCoverage'", "'evidencePresence'", "'sourceHealth'", "'delivery','unknown'"]) {
      expect(overview).toContain(fragment);
    }
    expect(overviewManaged).toContain(
      "REVOKE ALL ON FUNCTION public.customer_diagnostic_overview_v2(uuid,timestamptz,timestamptz,integer,text,integer) FROM PUBLIC, anon, authenticated",
    );
  });

  it("catalogs the portable migration bytes and invoker RPC ownership", () => {
    const path = "db/platform/migrations/20260913125000_customer_diagnostic_overview_v2.sql";
    const entry = manifest.forward.find((candidate) => candidate.file === path);
    expect(entry?.sha256).toBe(createHash("sha256").update(overviewPortable).digest("hex"));
    expect(rpcCatalog.groups.find((group) => group.name === "customer-diagnostic-history"))
      .toMatchObject({ securityDefinerExpected: false });
    expect(rpcCatalog.groups.find((group) => group.name === "customer-diagnostic-history")?.match)
      .toContain("^customer_diagnostic_overview_v2$");
  });

  it("backfills and defaults retained v1 coverage before accepting v2 rows", () => {
    expect(managed).toContain("SET LOCAL lock_timeout = '5s'");
    expect(managed).toContain("SET LOCAL statement_timeout = '30s'");
    expect(managed).toContain("ADD COLUMN coverage_version text NOT NULL DEFAULT 'purchase-auth-account.v1'");
    expect(managed).toContain("customer_diagnostic_events_coverage_version_check");
    expect(managed).toContain("NOT VALID");
    expect(managed).not.toContain("VALIDATE CONSTRAINT customer_diagnostic_events_coverage_version_check");
    expect(managed).toContain("purchase-auth-account.v2");
    expect(legacy).toContain("CREATE FUNCTION public.customer_diagnostic_ingest_v1");
  });

  it("keeps admission and immutable replay boundaries in the additive v2 append", () => {
    const ingest = functionBody("customer_diagnostic_ingest_v2");
    const count = ingest.indexOf("SELECT count(*) INTO v_global_count");
    const rejection = ingest.indexOf("RETURN jsonb_build_object('outcome','rate_limited')");
    const attempt = ingest.indexOf("INSERT INTO public.customer_diagnostic_ingress_attempts");
    const segment = ingest.indexOf("INSERT INTO public.customer_diagnostic_segments");
    const event = ingest.indexOf("INSERT INTO public.customer_diagnostic_events");
    expect(count).toBeLessThan(rejection);
    expect(rejection).toBeLessThan(attempt);
    expect(attempt).toBeLessThan(segment);
    expect(segment).toBeLessThan(event);
    expect(ingest).toContain("v_global_count >= 3000 OR v_bucket_count >= 120");
    expect(ingest).toContain(">= 20");
    expect(ingest).toContain("v_existing.coverage_version <> p_coverage_version");
    expect(functionBody("customer_diagnostic_ingest_v1")).toContain("v_existing.coverage_version <> 'purchase-auth-account.v1'");
  });

  it("pins the corrected v2 hydration matrix and browser ACLs", () => {
    const ingest = functionBody("customer_diagnostic_ingest_v2");
    for (const fragment of [
      "p_client_event_key IS NULL", "p_action IS NULL", "p_phase IS NULL", "p_code IS NULL",
      "p_abuse_key_hash IS NULL", "p_payload_fingerprint IS NULL", "p_ingest_request_id IS NULL",
      "p_retention_days IS NULL", "p_principal_id IS NULL AND p_subject_id IS NOT NULL",
      "p_coverage_version IS DISTINCT FROM 'purchase-auth-account.v2'",
      "p_action = 'entry_hydration'", "p_code = 'hydration_failed'",
    ]) expect(ingest).toContain(fragment);
    for (const name of ["customer_diagnostic_ingest_v2", "customer_diagnostic_search_v2", "customer_diagnostic_segment_v2"]) {
      expect(managed).toContain(`REVOKE ALL ON FUNCTION public.${name}`);
      expect(managed).toContain("FROM PUBLIC, anon, authenticated");
    }
  });

  it("keeps identity rotation and v2 read coverage per event", () => {
    const ingest = functionBody("customer_diagnostic_ingest_v2");
    expect(legacy).toContain("principal_id uuid");
    expect(ingest).toContain("v_segment.principal_id IS NOT DISTINCT FROM p_principal_id");
    expect(ingest).toContain("v_segment.subject_id IS NOT DISTINCT FROM p_subject_id");
    expect(ingest).toContain("v_segment.principal_id IS NULL AND p_principal_id IS NOT NULL");
    expect(ingest).not.toContain("UPDATE public.customer_diagnostic_segments SET subject_id");
  });

  it("writes retained access audit before releasing v2 search or history", () => {
    for (const name of ["customer_diagnostic_search_v2", "customer_diagnostic_segment_v2"]) {
      const read = functionBody(name);
      expect(read).toContain("communications_require_active_operator");
      expect(read.indexOf("INSERT INTO public.customer_diagnostic_access_events"))
        .toBeLessThan(read.lastIndexOf("RETURN"));
      expect(read).toContain("expires_at > v_now");
    }
    expect(functionBody("customer_diagnostic_search_v2")).toContain("'coverageVersion', coverage_version");
    expect(functionBody("customer_diagnostic_segment_v2")).toContain("'coverageVersion',coverage_version");
  });

  it("closes the reported reference to the three shapes TypeScript already spells", () => {
    const uuidPattern = literalRegexSource(reporter, "UUID");
    const canaryPattern = literalRegexSource(observedRequestId, "CANARY_REQUEST_ID");
    const hostedPattern = literalRegexSource(hostedProvenance, "HOSTED_REQUEST_ID");
    // The route's own gate must be the reporter's literal, or the route accepts what the table rejects.
    expect(literalRegexSource(observedRequestId, "REPORTED_UUID")).toBe(uuidPattern);
    expect(identityManaged).toContain("DROP CONSTRAINT customer_diagnostic_events_reported_ref_check");
    expect(identityManaged).toContain("ADD CONSTRAINT customer_diagnostic_events_reported_ref_check");
    expect(identityManaged).toContain(") NOT VALID;");
    expect(identityManaged).not.toContain("VALIDATE CONSTRAINT");
    // Character-identical, not merely equivalent: `~*` carries the reporter regex's /i flag.
    expect(identityManaged).toContain(`reported_request_id ~* '${uuidPattern}'`);
    expect(identityManaged).toContain(`reported_request_id ~ '${canaryPattern}'`);
    expect(identityManaged).toContain(`reported_request_id ~ '${hostedPattern}'`);
    const ingest = functionBody("customer_diagnostic_ingest_v2", identityManaged);
    expect(ingest).toContain(`p_reported_request_id ~* '${uuidPattern}'`);
    expect(ingest).toContain(`p_reported_request_id ~ '${canaryPattern}'`);
    expect(ingest).toContain(`p_reported_request_id ~ '${hostedPattern}'`);
    // The loose 128-character reference survives only in the untouched v1 ingest,
    // which the replaced table CHECK now backs.
    const loose = "p_reported_request_id !~ '^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$'";
    expect(ingest).not.toContain(loose);
    expect(functionBody("customer_diagnostic_ingest_v1")).toContain(loose);
    expect(identityManaged).not.toContain("customer_diagnostic_ingest_v1");
  });

  it("rotates a committed reuse inside the segment update and caps both lifetimes at the start", () => {
    const ingest = functionBody("customer_diagnostic_ingest_v2", identityManaged);
    const rotation = ingest.indexOf("credential_hash = CASE WHEN v_disposition = 'reused'");
    expect(rotation).toBeGreaterThan(ingest.indexOf("'deduplicated',true"));
    expect(rotation).toBeGreaterThan(ingest.lastIndexOf("RETURN jsonb_build_object('outcome','rate_limited')"));
    expect(rotation).toBeGreaterThan(ingest.indexOf("INSERT INTO public.customer_diagnostic_events("));
    expect(ingest).toContain("credential_hash = CASE WHEN v_disposition = 'reused' THEN p_issued_credential_hash ELSE credential_hash END");
    expect(ingest.split("credential_hash = CASE WHEN")).toHaveLength(2);
    expect(ingest).toContain("IF v_disposition = 'reused' THEN v_disposition := 'rotated'; END IF;");
    // Both caps read the segment's own start: the event through the variable bound in
    // each branch, the segment update through the column it is updating.
    expect(ingest).toContain("v_segment_started_at := v_segment.started_at;");
    expect(ingest).toContain("RETURNING id, started_at INTO v_segment_id, v_segment_started_at;");
    expect(ingest).toContain(
      "LEAST(v_segment_started_at + make_interval(days => p_retention_days), v_now + make_interval(days => p_retention_days))",
    );
    expect(ingest).toContain(
      "expires_at = LEAST(started_at + make_interval(days => p_retention_days),\n      GREATEST(expires_at, v_now + make_interval(days => p_retention_days)))",
    );
    expect(ingest).not.toContain("expires_at = GREATEST(expires_at, v_now + make_interval(days => p_retention_days))");
  });

  it("ships the ingress identity pair with parity, bounded timeouts and a catalogued digest", () => {
    expect(normalizeAuthority(identityPortable)).toBe(normalizeAuthority(identityManaged));
    expect(identityManaged).toContain("TO service_role");
    expect(identityPortable).not.toContain("service_role");
    expect(identityManaged).toContain("-- migration:allow-grant: ");
    expect(identityPortable).toContain("-- migration:allow-grant: ");
    for (const fragment of [
      "SET LOCAL lock_timeout = '5s'", "SET LOCAL statement_timeout = '30s'",
      "SET lock_timeout = '5s'", "SET statement_timeout = '30s'",
      "RESET lock_timeout", "RESET statement_timeout",
    ]) expect(identityManaged).toContain(fragment);
    expect(identityManaged).toContain(
      "REVOKE ALL ON FUNCTION public.customer_diagnostic_ingest_v2(text,text,uuid,uuid,uuid,uuid,text,text,text,integer,text,text,text,text,integer,text) FROM PUBLIC, anon, authenticated",
    );
    const path = "db/platform/migrations/20260914120000_customer_diagnostic_ingress_identity.sql";
    expect(manifest.forward.find((candidate) => candidate.file === path)?.sha256)
      .toBe(createHash("sha256").update(identityPortable).digest("hex"));
  });

  // The prune control pair is the wave's one deliberately DIVERGENT pair: the v3
  // allowlist column exists only on the managed chain, so byte parity after
  // normalizing grants would be the wrong assertion. What must hold is that the
  // divergence is exactly the documented one and that neither seed arms itself.
  it("seeds the retention control row disabled on both chains and diverges only where the schemas do", () => {
    for (const sql of [pruneManaged, prunePortable]) {
      expect(sql).toContain("INSERT INTO public.platform_job_controls");
      expect(sql).toMatch(/'customer-diagnostic-prune',\n\s+false,\n\s+'worker',/);
      expect(sql).toContain("ON CONFLICT (job_name) DO UPDATE");
      // An operator's flip, in either direction, survives a re-applied forward.
      expect(sql.slice(sql.lastIndexOf("ON CONFLICT (job_name)"))).not.toContain("enabled");
    }
    // Divergences are asserted against the STATEMENTS, not the file: each header
    // names the other chain's shape on purpose, and that prose is the point.
    const portableBody = prunePortable.slice(prunePortable.lastIndexOf("INSERT INTO"));
    const managedBody = pruneManaged.slice(pruneManaged.lastIndexOf("INSERT INTO"));
    // Managed only: a NULL allowlist makes platform_claim_job_run_v3 refuse outright.
    expect(managedBody).toContain("ARRAY['worker']::text[]");
    expect(portableBody).not.toContain("allowed_trigger_kinds");
    // The portable chain must NOT copy channel-order-pull's 'scheduler' driver:
    // this job claims as worker, and a mismatched driver is refused inactive_driver.
    expect(portableBody).not.toContain("'scheduler'");
    expect(portableBody).not.toContain("service_role");
    expect(portableBody).not.toContain("requiresFlag");
    expect(pruneManaged).toContain("-- migration:allow-dml: ");
    const path = "db/platform/migrations/20260914130000_customer_diagnostic_prune_job.sql";
    expect(manifest.forward.find((candidate) => candidate.file === path)?.sha256)
      .toBe(createHash("sha256").update(prunePortable).digest("hex"));
  });

  it("states the retention control delta in a header written for each chain", () => {
    const managedHeader = pruneManaged.slice(0, pruneManaged.indexOf("\nINSERT"));
    const portableHeader = prunePortable.slice(0, prunePortable.indexOf("\nINSERT"));
    expect(managedHeader).not.toBe(portableHeader);
    expect(managedHeader).toContain("platform_job_v3_control_not_configured");
    expect(managedHeader).toContain("COMMERCE_CUSTOMER_DIAGNOSTIC_PRUNE_ENABLED");
    expect(portableHeader).toContain("EVERY DEPARTURE FROM THE MANAGED TWIN");
    expect(portableHeader).toContain("inactive_driver");
    expect(managedHeader).not.toBe(identityManaged.slice(0, identityManaged.indexOf("\n\n")));
  });

  it("states the ingress identity delta in a header written for this replay", () => {
    const header = identityManaged.slice(0, identityManaged.indexOf("\n\n"));
    expect(header).toContain("customer_diagnostic_events_reported_ref_check");
    expect(header).toContain("NOT VALID");
    expect(header).toContain("rotate the segment credential");
    expect(header).toContain("LEAST(started_at + retention, ...)");
    expect(header).not.toBe(overviewManaged.slice(0, overviewManaged.indexOf("\n\n")));
    expect(header).not.toBe(managed.slice(0, managed.indexOf("\n\n")));
  });

  it("retains the v1 read signatures as v1-only views during mixed-history rollout", () => {
    const search = functionBody("customer_diagnostic_search_v1");
    const segment = functionBody("customer_diagnostic_segment_v1");
    expect(search).toContain("e.coverage_version = 'purchase-auth-account.v1'");
    expect(search).toContain("'coverageVersion','purchase-auth-account.v1'");
    expect(segment).toContain("coverage_version = 'purchase-auth-account.v1'");
    expect(segment).not.toContain("'coverageVersion',coverage_version");
  });
});

function functionBody(name: string, sql = managed): string {
  const start = sql.indexOf(`CREATE FUNCTION public.${name}`) >= 0
    ? sql.indexOf(`CREATE FUNCTION public.${name}`)
    : sql.indexOf(`CREATE OR REPLACE FUNCTION public.${name}`);
  const end = sql.indexOf("\n$$;", start);
  if (start < 0 || end < 0) throw new Error(`missing ${name}`);
  return sql.slice(start, end);
}

/** The exact source of a named TypeScript regular-expression literal, flags excluded. */
function literalRegexSource(source: string, name: string): string {
  const match = new RegExp(`const ${name} = /(.+)/[a-z]*;`).exec(source);
  if (!match) throw new Error(`missing ${name} regular expression literal`);
  return match[1];
}

function normalizeAuthority(sql: string): string {
  return sql.replace(/^--.*\n/gm, "").replace(/^GRANT .* TO service_role;\n/gm, "").trim();
}

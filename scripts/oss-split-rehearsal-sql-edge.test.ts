// This measures the SQL STAGE, not the repository. Most inputs are adversarial synthetic routines;
// three real migrations are characterization fixtures for the routing contract that motivated this
// repair. They prove the parser understands the checked-in guard shape without pinning a baseline.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import { isHostBearingSource, scanSql, sqlEdges, targetFunction, withheldFunctions } from "./oss-split-rehearsal-sql-edge.ts";

const withheld = ["fn/alpha-task/index.ts", "fn/beta-task/index.ts", "fn/beta-task/shared.ts", "other/notes.md"];
const reader = (files: Record<string, string>) => (path: string) => files[path] ?? "";

const helperContractFixture = ({
  check = "CHECK (endpoint IS NULL OR endpoint ~ '^https://[A-Za-z0-9.-]+/functions/v1/?$')",
  returned = "v_selected",
  connection = "SELECT app.read_base() INTO v_target;",
  extraMutation = "",
}: { check?: string; returned?: string; connection?: string; extraMutation?: string } = {}): string => [
  "CREATE TABLE app.routing (",
  "  id boolean PRIMARY KEY,",
  "  endpoint text,",
  `  ${check}`,
  ");",
  "CREATE OR REPLACE FUNCTION app.read_base()",
  "RETURNS text",
  "AS $helper$",
  "DECLARE",
  "  v_selected text;",
  "BEGIN",
  "  SELECT NULLIF(BTRIM(endpoint), '')",
  "    INTO v_selected",
  "    FROM app.routing",
  "   WHERE id = true;",
  "  v_selected := regexp_replace(v_selected, '/+$', '');",
  `  ${extraMutation}`,
  `  RETURN ${returned};`,
  "END;",
  "$helper$;",
  "CREATE OR REPLACE FUNCTION app.invoke()",
  "RETURNS void",
  "AS $caller$",
  "DECLARE",
  "  v_target text;",
  "BEGIN",
  `  ${connection}`,
  "  PERFORM net.http_post(",
  "    url := v_target || '/alpha-task',",
  "    body := '{}'::jsonb",
  "  );",
  "END;",
  "$caller$;",
].join("\n");

describe("withheld function inventory", () => {
  it("derives one directory per entrypoint and ignores everything else", () => {
    const found = withheldFunctions(withheld);
    expect([...found.keys()].sort()).toEqual(["alpha-task", "beta-task"]);
    expect(found.get("alpha-task")).toBe("fn/alpha-task");
  });

  it("yields nothing when no entrypoint is present", () => {
    expect(withheldFunctions(["other/notes.md"]).size).toBe(0);
  });
});

describe("target expression resolution", () => {
  const assigned = new Map([["v_target", ["v_base || '/beta-task'"]], ["v_dead", ["upper(x)"]]]);
  const edge = new Map([["v_base", "edge-function" as const]]);
  const application = new Map([["v_base", "application-cron" as const]]);

  it("reads a literal target", () => {
    expect(targetFunction("'https://host.example/functions/v1/alpha-task',", assigned)).toEqual({
      provenance: "edge-function",
      slug: "alpha-task",
    });
    expect(targetFunction("'https://host.example/api/cron/alpha-task',", assigned)).toEqual({
      provenance: "application-cron",
      slug: "alpha-task",
    });
    expect(targetFunction("coalesce(v_url, 'https://host.example/api/cron/alpha-task')", assigned).provenance).toBe("unknown");
  });

  it("reads a target concatenated in place only with proven provenance", () => {
    expect(targetFunction("v_base || '/alpha-task',", assigned, edge)).toEqual({
      provenance: "edge-function",
      slug: "alpha-task",
    });
    expect(targetFunction("v_base || '/alpha-task',", assigned, application)).toEqual({
      provenance: "application-cron",
      slug: "alpha-task",
    });
    expect(targetFunction("v_base || '/alpha-task',", assigned).provenance).toBe("unknown");
  });

  // The whole reason this stage exists: real call sites name the function only in an
  // assignment several lines above the call, so a literal-only reader misses them entirely.
  it("follows an identifier back to its assignment", () => {
    expect(targetFunction("v_target,", assigned, edge)).toEqual({ provenance: "edge-function", slug: "beta-task" });
  });

  it("returns a named unknown verdict when nothing proves a target", () => {
    expect(targetFunction("v_dead,", assigned)).toEqual({
      provenance: "unknown",
      diagnostic: "the nearest assignment of v_dead does not prove a target namespace",
    });
    expect(targetFunction("v_unknown,", assigned).provenance).toBe("unknown");
  });
});

describe("SQL edges over a published tree", () => {
  const direct = [
    "SELECT net.http_post(",
    "  url := 'https://aaaaaaaaaaaaaaaaaaaa.example.test/functions/v1/alpha-task',",
    "  body := '{}'::jsonb",
    ");",
  ].join("\n");
  const indirect = [
    "DECLARE",
    "  v_target_url text;",
    "BEGIN",
    "  IF v_base_url !~ '^https://[A-Za-z0-9.-]+/functions/v1$' THEN",
    "    RAISE EXCEPTION 'requires_edge_namespace';",
    "  END IF;",
    "  v_target_url := v_base_url || '/beta-task';",
    "  PERFORM net.http_post(",
    "    url := v_target_url,",
    "    body := '{}'::jsonb",
    "  );",
    "END;",
  ].join("\n");

  it("counts a call into a withheld function once per file and target", () => {
    const { calls, sites } = sqlEdges(["m/one.sql", "m/two.sql"], withheld, reader({ "m/one.sql": direct, "m/two.sql": indirect }));
    expect(calls).toEqual(["m/one.sql -> fn/alpha-task", "m/two.sql -> fn/beta-task"]);
    expect(sites).toBe(2);
  });

  it("classifies guarded application-cron calls but excludes them from Edge debt", () => {
    const applicationCron = [
      "CREATE OR REPLACE FUNCTION app.invoke_task() RETURNS void",
      "AS $function$",
      "BEGIN",
      "  v_base_url := regexp_replace(v_config.base_url, '/+$', '');",
      "  IF v_base_url !~ '^https://[A-Za-z0-9.-]+/api/cron$' THEN",
      "    RAISE EXCEPTION 'requires_application_cron_url:%', v_base_url;",
      "  END IF;",
      "  v_target_url := v_base_url || '/alpha-task';",
      "  PERFORM net.http_post(",
      "    url := v_target_url,",
      "    body := '{}'::jsonb",
      "  );",
      "END;",
      "$function$;",
    ].join("\n");
    const { calls, sites } = sqlEdges(["m/app.sql"], withheld, reader({ "m/app.sql": applicationCron }));
    expect(calls).toEqual([]);
    expect(sites).toBe(1);
  });

  it("accepts a literal base namespace without a guard", () => {
    const literalBase = [
      "v_base_url := 'https://host.example/functions/v1';",
      "PERFORM net.http_post(",
      "  url := v_base_url || '/alpha-task',",
      "  body := '{}'::jsonb",
      ");",
    ].join("\n");
    expect(sqlEdges(["m/literal.sql"], withheld, reader({ "m/literal.sql": literalBase })).calls).toEqual([
      "m/literal.sql -> fn/alpha-task",
    ]);
  });

  it("accepts a same-file helper contract backed by an anchored column CHECK", () => {
    expect(sqlEdges(["m/helper.sql"], withheld, reader({ "m/helper.sql": helperContractFixture() })).calls).toEqual([
      "m/helper.sql -> fn/alpha-task",
    ]);
  });

  it.each([
    ["missing", ""],
    ["loose", "CHECK (endpoint IS NULL OR endpoint ~ 'functions/v1')"],
    ["alternating", "CHECK (endpoint IS NULL OR endpoint ~ '^https://safe.example/functions/v1$|^https://evil.example/api/cron/functions/v1$')"],
    ["commented-out", "/* CHECK (endpoint IS NULL OR endpoint ~ '^https://host.example/functions/v1/?$') */"],
  ])("fails closed when the helper's column has a %s CHECK", (_label, check) => {
    const fixture = helperContractFixture({ check });
    expect(() => sqlEdges(["m/helper.sql"], withheld, reader({ "m/helper.sql": fixture }))).toThrow(
      /unknown provenance[\s\S]*namespace of v_target is not proven/,
    );
  });

  it("fails closed when the helper returns a value other than the checked selection", () => {
    const fixture = helperContractFixture({ returned: "v_other" });
    expect(() => sqlEdges(["m/helper.sql"], withheld, reader({ "m/helper.sql": fixture }))).toThrow(/unknown provenance/);
  });

  it("fails closed when the helper overwrites the checked selection before returning it", () => {
    const fixture = helperContractFixture({ extraMutation: "SELECT 'https://host.example/api/cron' INTO v_selected;" });
    expect(() => sqlEdges(["m/helper.sql"], withheld, reader({ "m/helper.sql": fixture }))).toThrow(/unknown provenance/);
  });

  it("fails closed without the exact SELECT helper() INTO local-variable connection", () => {
    const fixture = helperContractFixture({ connection: "v_target := app.read_base();" });
    expect(() => sqlEdges(["m/helper.sql"], withheld, reader({ "m/helper.sql": fixture }))).toThrow(/unknown provenance/);
  });

  it("uses the last helper definition and rejects an untrusted replacement", () => {
    const invalidReplacement = [
      "CREATE OR REPLACE FUNCTION app.read_base() RETURNS text",
      "AS $replacement$",
      "BEGIN",
      "  RETURN current_setting('app.base_url');",
      "END;",
      "$replacement$;",
    ].join("\n");
    expect(() => sqlEdges(["m/helper.sql"], withheld, reader({ "m/helper.sql": helperContractFixture().replace("CREATE OR REPLACE FUNCTION app.invoke()", `${invalidReplacement}\nCREATE OR REPLACE FUNCTION app.invoke()`) }))).toThrow(/unknown provenance/);
  });

  it("uses the nearest preceding assignment and invalidates shadowed namespace evidence", () => {
    const shadowed = [
      "IF v_base_url !~ '^https://host.example/api/cron$' THEN",
      "  RAISE EXCEPTION 'requires_application_cron';",
      "END IF;",
      "v_target_url := v_base_url || '/alpha-task';",
      "v_target_url := 'https://host.example/functions/v1/beta-task';",
      "PERFORM net.http_post(",
      "  url := v_target_url,",
      "  body := '{}'::jsonb",
      ");",
    ].join("\n");
    expect(sqlEdges(["m/shadowed.sql"], withheld, reader({ "m/shadowed.sql": shadowed })).calls).toEqual([
      "m/shadowed.sql -> fn/beta-task",
    ]);

    const reassignedBase = shadowed
      .replace("v_target_url := v_base_url || '/alpha-task';\n", "v_base_url := current_setting('app.base_url');\n")
      .replace("v_target_url := 'https://host.example/functions/v1/beta-task';", "v_target_url := v_base_url || '/beta-task';");
    expect(() => sqlEdges(["m/reassigned.sql"], withheld, reader({ "m/reassigned.sql": reassignedBase }))).toThrow(
      /unknown provenance[\s\S]*namespace of v_base_url is not proven/,
    );
  });

  it("does not carry assignments or guard evidence across routine boundaries", () => {
    const routines = [
      "CREATE OR REPLACE FUNCTION app.first() RETURNS void",
      "AS $function$",
      "BEGIN",
      "  IF v_base_url !~ '^https://host.example/api/cron$' THEN",
      "    RAISE EXCEPTION 'requires_application_cron';",
      "  END IF;",
      "  PERFORM net.http_post(url := v_base_url || '/alpha-task');",
      "END;",
      "$function$;",
      "CREATE OR REPLACE FUNCTION app.second() RETURNS void",
      "AS $function$",
      "BEGIN",
      "  PERFORM net.http_post(url := v_base_url || '/beta-task');",
      "END;",
      "$function$;",
    ].join("\n");
    expect(() => sqlEdges(["m/routines.sql"], withheld, reader({ "m/routines.sql": routines }))).toThrow(
      /m\/routines\.sql:13: the namespace of v_base_url is not proven/,
    );
  });

  it.each([
    [
      "comment-only",
      [
        "-- IF v_base_url !~ '^https://host.example/api/cron$' THEN",
        "--   RAISE EXCEPTION 'reject';",
        "-- END IF;",
      ].join("\n"),
    ],
    [
      "unanchored-regex",
      ["IF v_base_url !~ 'https://host.example/api/cron' THEN", "  RAISE EXCEPTION 'reject';", "END IF;"].join("\n"),
    ],
    ["non-https-route", ["IF v_base_url !~ '^junk/api/cron$' THEN", "  RAISE EXCEPTION 'reject';", "END IF;"].join("\n")],
    ["extra-prefix-segment", ["IF v_base_url !~ '^https://host.example/evil/api/cron$' THEN", "  RAISE EXCEPTION 'reject';", "END IF;"].join("\n")],
    ["positive-only", ["IF v_base_url ~ '^https://host.example/api/cron$' THEN", "  RAISE EXCEPTION 'reject';", "END IF;"].join("\n")],
    ["no-exception", ["IF v_base_url !~ '^https://host.example/api/cron$' THEN", "  RETURN;", "END IF;"].join("\n")],
    ["alternating-namespace", ["IF v_base_url !~ '^https://host.example/functions/v1$|^https://host.example/api/cron$' THEN", "  RAISE EXCEPTION 'reject';", "END IF;"].join("\n")],
    ["caught-exception", ["IF v_base_url !~ '^https://host.example/api/cron$' THEN", "  BEGIN", "    RAISE EXCEPTION 'reject';", "  EXCEPTION WHEN OTHERS THEN NULL;", "  END;", "END IF;"].join("\n")],
  ])("fails closed for the hostile %s near miss", (_label, prelude) => {
    const hostile = `${prelude}\nPERFORM net.http_post(\n  url := v_base_url || '/alpha-task',\n  body := '{}'::jsonb\n);`;
    expect(() => sqlEdges(["m/hostile.sql"], withheld, reader({ "m/hostile.sql": hostile }))).toThrow(/unknown provenance/);
  });

  it("ignores a call the published tree can still answer", () => {
    const kept = direct.replace("alpha-task", "kept-task");
    const { calls, sites } = sqlEdges(["m/one.sql"], withheld, reader({ "m/one.sql": kept }));
    expect(calls).toEqual([]);
    expect(sites).toBe(1);
  });

  it("skips a commented-out call site", () => {
    const commented = `-- url := 'https://aaaaaaaaaaaaaaaaaaaa.example.test/functions/v1/alpha-task',\n${direct}`;
    const { calls, sites } = sqlEdges(["m/one.sql"], withheld, reader({ "m/one.sql": commented }));
    expect(calls).toEqual(["m/one.sql -> fn/alpha-task"]);
    expect(sites).toBe(1);
  });

  it("pins hosts by shape, so an unrelated project's host is caught the same way", () => {
    const mixed = `${direct}\n-- see https://bbbbbbbbbbbbbbbbbbbb.example.test for the mirror\n-- and https://short.example.test which is not pinned`;
    const { hosts, hostSites } = sqlEdges(["m/one.sql"], withheld, reader({ "m/one.sql": mixed }));
    expect(hosts).toEqual([
      "m/one.sql -> aaaaaaaaaaaaaaaaaaaa.example.test",
      "m/one.sql -> bbbbbbbbbbbbbbbbbbbb.example.test",
    ]);
    expect(hostSites).toBe(2);
  });

  it("reads a bare configured reference outside SQL, and never inside it", () => {
    const configured = 'project_id = "cccccccccccccccccccc"\nport = 55421\nname = "short"\n';
    const { hosts, hostSites } = sqlEdges(["m/one.sql", "cfg/settings.toml"], withheld, reader({ "m/one.sql": direct, "cfg/settings.toml": configured }));
    expect(hosts).toEqual(["cfg/settings.toml -> cccccccccccccccccccc", "m/one.sql -> aaaaaaaaaaaaaaaaaaaa.example.test"]);
    expect(hostSites).toBe(2);
    // The same twenty-character shape inside SQL is an ordinary generated identifier, not a
    // deployment, so reading it there would manufacture findings rather than reveal them.
    const inSql = `${direct}\n-- id = 'cccccccccccccccccccc'`;
    expect(sqlEdges(["m/one.sql"], withheld, reader({ "m/one.sql": inSql })).hostSites).toBe(1);
  });

  it("selects the sources both host measurements read", () => {
    expect(["m/one.sql", "cfg/settings.toml"].filter(isHostBearingSource)).toEqual(["m/one.sql", "cfg/settings.toml"]);
    expect(["cfg/settings.json", "readme.md"].filter(isHostBearingSource)).toEqual([]);
  });

  it("is fatal when the withheld partition yields no function", () => {
    expect(() => sqlEdges(["m/one.sql"], ["other/notes.md"], reader({ "m/one.sql": direct }))).toThrow(/partition is dead/);
  });

  it("is fatal when no call site is found, rather than reporting no debt", () => {
    expect(() => sqlEdges(["m/one.sql"], withheld, reader({ "m/one.sql": "SELECT 1;" }))).toThrow(/extraction is dead/);
  });

  it("is fatal when a call site's provenance is unknown, rather than reporting no debt", () => {
    const unresolvable = "PERFORM net.http_post(\n  url := v_nowhere,\n  body := '{}'::jsonb\n);";
    expect(() => sqlEdges(["m/one.sql"], withheld, reader({ "m/one.sql": unresolvable }))).toThrow(
      /unknown provenance[\s\S]*m\/one\.sql:2/,
    );
    expect(() => scanSql(["m/one.sql"], withheld, reader({ "m/one.sql": unresolvable }))).toThrow(
      /unknown provenance[\s\S]*m\/one\.sql:2/,
    );
  });
});

describe("checked-in scheduler routing characterization", () => {
  const schedulerFunctions = [
    "supabase/functions/outbox-dispatch/index.ts",
    "supabase/functions/promotion-claim-sweep/index.ts",
    "supabase/functions/omnipack-stock-sync/index.ts",
    "supabase/functions/omnipack-reconciliation/index.ts",
    "supabase/functions/send-email/index.ts",
  ];

  it("recognizes the #3303 application-cron guard shape and adds no Edge pairs", () => {
    const migration = "supabase/migrations/20260831150000_retarget_staging_bridge_schedulers_to_application_cron.sql";
    const contents = readFileSync("supabase/migrations/20260831150000_retarget_staging_bridge_schedulers_to_application_cron.sql", "utf8");
    const measured = sqlEdges([migration], schedulerFunctions, reader({ [migration]: contents }));
    expect(measured.sites).toBe(4);
    expect(measured.calls).toEqual([]);
  });

  it("still records the legacy guarded /functions/v1 scheduler as an Edge pair", () => {
    const migration = "supabase/migrations/20260711140003_omnipack_stock_sync_pgcron_scheduler.sql";
    const contents = readFileSync("supabase/migrations/20260711140003_omnipack_stock_sync_pgcron_scheduler.sql", "utf8");
    const measured = sqlEdges([migration], schedulerFunctions, reader({ [migration]: contents }));
    expect(measured.sites).toBe(1);
    expect(measured.calls).toEqual([
      `${migration} -> supabase/functions/omnipack-stock-sync`,
    ]);
  });

  it("proves the checked-column helper path to the existing send-email Edge call", () => {
    const migration = "supabase/migrations/20260629100000_email_cron_runtime_hardening.sql";
    const contents = readFileSync("supabase/migrations/20260629100000_email_cron_runtime_hardening.sql", "utf8");
    const measured = sqlEdges([migration], schedulerFunctions, reader({ [migration]: contents }));
    expect(measured.sites).toBe(1);
    expect(measured.calls).toEqual([
      `${migration} -> supabase/functions/send-email`,
    ]);
  });
});

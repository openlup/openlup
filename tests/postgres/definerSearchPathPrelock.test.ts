import { describe, expect, it } from "vitest";
import migrationManifest from "../../config/platform-migration-manifest.json" with { type: "json" };
import type { PlatformMigrationManifest } from "../../scripts/platform-migration-manifest.js";
import { withPlatformCatalog } from "../helpers/issuedPlatformCatalog.js";
import { postgresSetupTimeoutMs } from "../helpers/postgresContainer.js";
import { fixture, graph, insertGraph, installPublicationActors, transaction } from "./catalogPublicationFixture.js";
import { installAccountMutations, prelockForward, profiles, withContainerSlot } from "./definerSearchPath.fixture.js";

const runInContainerSlot = withContainerSlot(2);

describe("runtime checkout prelock upgrade", () => {
  it.concurrent.each(profiles)("preserves the runtime checkout identity and ACLs through the prelock upgrade on %s", async profile => runInContainerSlot(async () => {
    if (migrationManifest.schemaVersion !== 3) throw new Error("Expected the complete platform migration catalogue");
    const prefix: Extract<PlatformMigrationManifest, { schemaVersion: 3 }> = { ...structuredClone(migrationManifest), schemaVersion: 3 };
    for (const plan of [prefix, prefix.qualified, prefix.qualifiedAdmin]) {
      const first = plan.forward.findIndex(unit => unit.file === prelockForward.path);
      expect(first).toBeGreaterThan(0);
      plan.forward = plan.forward.slice(0, first);
    }
    const { owner, runner, runtime, close } = await withPlatformCatalog(prefix, root => installAccountMutations(profile, true, "checkout-prelock", root));
    try {
      const signature = prelockForward.replacedFunctions[0]!.signature;
      const facts = async () => (await owner.query(`SELECT to_jsonb(p)-'prosrc' AS routine,p.prosrc AS body,
        (SELECT jsonb_agg(jsonb_build_array(r.rolname,has_function_privilege(r.oid,p.oid,'EXECUTE')) ORDER BY r.rolname) FROM pg_roles r) AS acl,
        (SELECT jsonb_agg(to_jsonb(a) ORDER BY a.oid) FROM pg_default_acl a) AS defaults
        FROM pg_proc p WHERE p.oid=$1::regprocedure`, [signature])).rows[0]!;
      const { body, ...prior } = await facts();
      expect((await runner.apply()).applied[0]).toBe(prelockForward.path);
      expect((await runner.apply()).applied).toEqual([]);
      // The runner acknowledges the migration COMMIT before replay and the fresh catalogue reads.
      const { body: installed, ...after } = await facts();
      expect(after).toEqual(prior);
      expect(installed).not.toBe(body);
      expect(after.routine).toMatchObject({ prosecdef: true, proconfig: ["search_path=pg_catalog, pg_temp"] });

      const helpers = ["catalog_admission_lock_shared()", "catalog_admission_lock_checkout_price(uuid,uuid[])",
        "catalog_price_setup_lock_context(uuid,uuid)"];
      expect((await owner.query(`SELECT p.proowner::text,p.proconfig FROM unnest($1::text[]) s
        JOIN pg_proc p ON p.oid=('public.'||s)::regprocedure`, [helpers])).rows)
        .toEqual(helpers.map(() => ({ proowner: after.routine.proowner, proconfig: ["search_path=pg_catalog, pg_temp"] })));
      const { rows: [login] } = await runtime.query("SELECT current_user AS name");
      expect((await owner.query(`SELECT rolname FROM pg_roles WHERE rolname=ANY($1::text[]) AND NOT rolsuper
        AND has_schema_privilege(oid,'public','CREATE')
        UNION ALL SELECT 'PUBLIC' FROM pg_namespace n,aclexplode(n.nspacl) a
        WHERE n.nspname='public' AND a.grantee=0 AND a.privilege_type='CREATE'`,
      [[login.name, "service_role", "anon", "authenticated", "openlup_catalog_publication"]])).rows).toEqual([]);

      await installPublicationActors(owner);
      const scope = await transaction(owner, async db => {
        const issue = await graph(db, fixture(), null, true, { lifecycle: "active", subscriptionEligible: true });
        await insertGraph(db, issue);
        const legacy = fixture();
        await db.query("INSERT INTO public.catalog_products(id,slug,name) VALUES($1,$2,'Example')", [legacy.productId, legacy.productId]);
        await db.query("INSERT INTO public.catalog_skus(id,product_id,sku,title,sellable_in_subscription) VALUES($1,$2,$3,'Example',true)",
          [legacy.skuId, legacy.productId, legacy.skuId]);
        const { rows: [list] } = await db.query("INSERT INTO public.price_lists(name,region_code,currency) VALUES('Example','ZZ','XXX') RETURNING id");
        const { rows: [client] } = await db.query("INSERT INTO public.clients(email) VALUES('prelock@example.invalid') RETURNING id");
        return { client: client.id, payload: { skuIds: [issue.skuId, legacy.skuId], skuRevisionId: issue.skuRevisionId, priceListId: list.id } };
      });
      // The transaction helper acknowledges the seed COMMIT before the runtime role reads it.
      const call = "SELECT public.catalog_admission_runtime_checkout($1::pg_catalog.text,$2::pg_catalog.text,$3::pg_catalog.uuid,$4::pg_catalog.jsonb) AS result";
      const key = "fixture-checkout-key";
      await transaction(runtime, async db => {
        await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
        await db.query("SET LOCAL lock_timeout='500ms'; SET LOCAL statement_timeout='3s'; SET LOCAL search_path=pg_temp,public,pg_catalog");
        await db.query("SELECT pg_catalog.pg_advisory_xact_lock(pg_catalog.hashtextextended($1,0))", [key]);
        await db.query("CREATE TEMP TABLE clients(id pg_catalog.uuid) ON COMMIT DROP");
        expect((await db.query(call, ["prelock", key, scope.client, scope.payload])).rows).toEqual([{ result: { kind: "locked" } }]);
      });
      await expect(runtime.query(call, ["write", key, scope.client, scope.payload])).rejects.toMatchObject({
        code: "55000", message: "catalog_admission_quote_authority_required",
        hint: "Governed checkout is unavailable for this selection. Use a supported offer or replay the original request.",
      });
    } finally { await close(); }
  }), postgresSetupTimeoutMs);
});

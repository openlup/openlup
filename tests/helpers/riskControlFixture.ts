import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { Pool } from "pg";
import { imageReference, readCiImage } from "../../scripts/ci-image-pull.mjs";
import { closePostgres, dockerAvailable, runPostgresContainer, waitForPostgresTcpReady, type PostgresContainer } from "./postgresContainer.js";
export const AT = "2026-01-15T12:00:00.000Z";
export const evaluation = (decision = "manual_review") => ({ decision, score: decision === "allow" ? 0 : 65, severity: decision === "allow" ? "low" : "high", reasonCodes: decision === "allow" ? [] : ["bundle_discount_review"], matchedRules: [] });
export function riskControlFixture(rail: "native" | "managed") {
    const native = rail === "native";
    let container: PostgresContainer | undefined;
    let owner: Pool, runtime: Pool, browser: Pool;
    const operator = randomUUID();
    return {
        rail, native, operator,
        get owner() { return owner; }, get runtime() { return runtime; }, get browser() { return browser; },
        async start() {
            if (!await dockerAvailable())
                throw new Error("risk preservation requires real Docker PostgreSQL");
            const image = readCiImage(native ? "test-postgres" : "managed-batch-postgres");
            container = await runPostgresContainer({ name: `m15-risk-${rail}-${process.pid}`, password: "synthetic-risk-proof", image: imageReference(image, image.sources.at(-1)) });
            if (!await waitForPostgresTcpReady(container.connectionString))
                throw new Error("risk PostgreSQL unavailable");
            owner = new Pool({ connectionString: native ? container.connectionString : container.connectionString.replace("postgres://postgres:", "postgres://supabase_admin:"), max: 1 });
            if (native) {
                const manifest = JSON.parse(readFileSync("config/platform-migration-manifest.json", "utf8"));
                const units = [manifest.baseline, ...manifest.forward];
                const end = units.findIndex(unit => unit.file === "db/platform/migrations/20260813230000_post_order_control.sql");
                if (end < 0)
                    throw new Error("risk catalogue unit missing");
                for (const unit of units.slice(0, end + 1)) {
                    const bytes = readFileSync(unit.file);
                    if (createHash("sha256").update(bytes).digest("hex") !== unit.sha256)
                        throw new Error(`risk prefix pin mismatch: ${unit.file}`);
                    await owner.query(bytes.toString());
                }
                // Fixture composition only. The native unit deliberately defines no production roles/grants.
                await owner.query(`CREATE ROLE risk_runtime NOLOGIN; CREATE ROLE risk_browser NOLOGIN;
      GRANT USAGE ON SCHEMA public TO risk_runtime,risk_browser;
      GRANT SELECT,INSERT,UPDATE ON risk_assessments,risk_manual_review_cases,risk_case_events,commerce_order_holds,commerce_order_operations,commerce_orders TO risk_runtime;
      GRANT SELECT ON risk_blocklist_entries,commerce_orders,commerce_settlement_intents,commerce_operators TO risk_runtime`);
                await owner.query("INSERT INTO commerce_operators(id,label) VALUES($1,'Synthetic operator')", [operator]);
            }
            else {
                await owner.query(readFileSync("scripts/public-reference/subscription-prereqs.sql", "utf8"));
                for (const role of ["postgres", "supabase_admin"])
                    for (const scope of ["", " IN SCHEMA public"])
                        for (const kind of ["TABLES", "SEQUENCES", "FUNCTIONS"])
                            await owner.query(`ALTER DEFAULT PRIVILEGES FOR ROLE ${role}${scope} REVOKE ALL ON ${kind} FROM PUBLIC,anon,authenticated,service_role`);
                const baseline = readFileSync("supabase/migrations/00000000000000_platform_schema_baseline.sql");
                if (createHash("sha256").update(baseline).digest("hex") !== "fb4de62d4ccf30dca83075b41ea2769ddf74165ecd47d21875790ed5f397ccbe")
                    throw new Error("risk managed baseline pin mismatch");
                await owner.query("SET ROLE postgres; SET search_path=public,extensions");
                await owner.query(baseline.toString().replace(/^\\(?:un)?restrict [A-Za-z0-9]+\r?$/gmu, ""));
                await owner.query("RESET ROLE; CREATE EXTENSION IF NOT EXISTS pgtap WITH SCHEMA extensions; SET search_path=public,extensions");
                // Host-composed read capability for the structural managed evidence client.
                // The frozen baseline grants risk RPC execution, not commerce table reads.
                await owner.query("GRANT SELECT ON commerce_orders,commerce_payment_intents TO service_role");
                await owner.query("INSERT INTO admin_users(id,email,role,is_machine_actor) VALUES($1,$2,'admin',false)", [operator, `${operator}@example.invalid`]);
            }
            // Separate authenticated, non-superuser sessions exercise the actual selected role.
            for (const [login, role] of [["risk_test_runtime", native ? "risk_runtime" : "service_role"], ["risk_test_browser", native ? "risk_browser" : "authenticated"]]) {
                await owner.query(`CREATE ROLE ${login} LOGIN PASSWORD 'synthetic-risk-proof' NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS; GRANT ${role} TO ${login}`);
            }
            const url = new URL(container.connectionString);
            url.username = "risk_test_runtime";
            runtime = new Pool({ connectionString: url.toString(), max: 1, options: `-c role=${native ? "risk_runtime" : "service_role"} -c search_path=public,extensions` });
            url.username = "risk_test_browser";
            browser = new Pool({ connectionString: url.toString(), max: 1, options: `-c role=${native ? "risk_browser" : "authenticated"} -c search_path=public,extensions` });
        },
        async stop() { await closePostgres(container, [runtime, browser, owner]); },
        async seed(status = "paid", payment = true) {
            const order = randomUUID(), client = randomUUID(), intent = randomUUID();
            await owner.query("INSERT INTO clients(id,email) VALUES($1,$2)", [client, `${client}@example.invalid`]);
            if (native) {
                const tx = await owner.connect();
                try {
                    await tx.query("BEGIN");
                    await tx.query("INSERT INTO commerce_orders(id,client_id,status,currency_code,total_amount_minor) VALUES($1,$2,$3,'XTS',900)", [order, client, status]);
                    await tx.query("INSERT INTO commerce_order_items(order_id,line_ordinal,quantity,unit_amount_minor,line_amount_minor) VALUES($1,1,1,900,900)", [order]);
                    await tx.query("COMMIT");
                }
                catch (error) {
                    await tx.query("ROLLBACK");
                    throw error;
                }
                finally {
                    tx.release();
                }
                if (payment)
                    await owner.query("INSERT INTO commerce_settlement_intents(id,order_id,channel_key,status,amount_minor,currency_code,open_idempotency_key,settled_at) VALUES($1,$2,'fixture','settled',900,'XTS',$3,now())", [intent, order, `intent-${intent}`]);
            }
            else {
                await owner.query("INSERT INTO commerce_orders(id,client_id,status,subtotal_cents,total_cents,currency,mode) VALUES($1,$2,$3,900,900,'XTS','one_time')", [order, client, status]);
                if (payment) {
                    const paymentId = randomUUID();
                    await owner.query("INSERT INTO commerce_payments(id,order_id,provider,status,amount_cents) VALUES($1,$2,'fixture','succeeded',900)", [paymentId, order]);
                    await owner.query("INSERT INTO commerce_payment_intents(id,target_kind,order_id,payment_id,amount_cents,currency,status) VALUES($1,'one_time_order',$2,$3,900,'XTS','succeeded')", [intent, order, paymentId]);
                }
            }
            return { order, client, intent: payment ? intent : null, key: `risk-${order}` };
        },
        async assess(f: {
            order: string;
            intent: string | null;
            key: string;
        }, options: {
            decision?: string;
            mode?: string;
            at?: string;
            evidence?: unknown;
            key?: string;
        } = {}) {
            return (await runtime.query("SELECT risk_assess_paid_order($1,$2,$3,NULL,$4,$5,$6,$7,$8) AS value", [options.key ?? f.key, f.order, f.intent, options.mode ?? "hold", evaluation(options.decision), JSON.stringify([{ subjectKind: "client", subjectHash: "synthetic-subject-hash" }]), JSON.stringify(options.evidence ?? { sanitized: true }), options.at ?? AT])).rows[0].value;
        },
        async decide(caseId: string, decision: string, key = `decision-${randomUUID()}`, actor = operator, note = "Synthetic note") {
            return (await runtime.query("SELECT risk_resolve_manual_review_case($1,$2,$3,$4,$5,'{}') AS value", [key, caseId, decision, actor, note])).rows[0].value;
        },
    };
}

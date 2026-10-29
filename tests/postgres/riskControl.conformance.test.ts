import { createHash, randomUUID } from "node:crypto";
import { readFileSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { RISK_MIGRATIONS, createPostgresRiskControlPorts, createSupabaseOrderPaidRiskAssessmentPort, type RiskSupabaseClient } from "@openlup/platform/risk/server";
import { postgresSetupTimeoutMs, postgresTeardownTimeoutMs } from "../helpers/postgresContainer.js";
import { AT, riskControlFixture } from "../helpers/riskControlFixture.js";
// Seven independent C1 scenarios on each rail. Assertions characterize differences;
// they deliberately do not normalize decisions, replay identity or privileges.
describe.each(["native", "managed"] as const)("risk SQL preservation: %s", rail => {
    const f = riskControlFixture(rail);
    beforeAll(() => f.start(), postgresSetupTimeoutMs);
    afterAll(() => f.stop(), postgresTeardownTimeoutMs);
    it("preserves canonical SQL bytes, invoker/definer permissions and browser refusal; reuses managed pgTAP", async () => {
        const unit = RISK_MIGRATIONS[0];
        const bytes = readFileSync(unit.url);
        expect(bytes).toEqual(readFileSync(unit.catalogPath));
        expect(createHash("sha256").update(bytes).digest("hex")).toBe(unit.sha256);
        expect((await f.runtime.query("SELECT current_user,session_user,(SELECT rolsuper FROM pg_roles WHERE rolname=session_user) AS super")).rows[0]).toMatchObject({ current_user: f.native ? "risk_runtime" : "service_role", session_user: "risk_test_runtime", super: false });
        expect((await f.owner.query("SELECT prosecdef FROM pg_proc WHERE oid='public.risk_check_exact_blocklist(jsonb)'::regprocedure")).rows[0].prosecdef).toBe(!f.native);
        await expect(f.browser.query("SELECT risk_check_exact_blocklist('[]')")).rejects.toMatchObject({ code: "42501" });
        await expect(f.browser.query("SELECT * FROM risk_assessments")).rejects.toMatchObject({ code: "42501" });
        expect((await f.runtime.query("SELECT risk_check_exact_blocklist('[]') AS value")).rows[0].value.blocked).toBe(false);
        if (!f.native) {
            const result = await f.owner.query(readFileSync("supabase/tests/risk_blocklist_test.sql", "utf8"));
            const tap = (Array.isArray(result) ? result : [result]).flatMap(r => r.rows.flatMap((row: Record<string, unknown>) => Object.values(row))).filter((v): v is string => typeof v === "string");
            expect(tap.filter(line => line.startsWith("not ok"))).toEqual([]);
            expect(tap.filter(line => /^ok \d/.test(line))).toHaveLength(5);
            console.info("risk_blocklist_test.sql pgTAP: 5/5", tap);
        }
    });
    it("allow has no case; shadow non-allow returns a decision without a hold with rail-specific case creation", async () => {
        const allow = await f.assess(await f.seed(), { decision: "allow" });
        expect(allow).toMatchObject({ decision: "allow", caseId: null, holdId: null, holdOpened: false, replayed: false });
        const shadow = await f.assess(await f.seed(), { mode: "shadow" });
        expect(shadow).toMatchObject({ decision: "manual_review", holdId: null, holdOpened: false });
        expect(shadow.caseId === null).toBe(!f.native);
        expect((await f.owner.query("SELECT count(*)::int AS n FROM risk_assessments WHERE id=ANY($1::uuid[])", [[allow.assessmentId, shadow.assessmentId]])).rows[0].n).toBe(2);
    });
    it("hold review escalates, notes and approves with an audit trail and a released hold; closed decisions differ", async () => {
        const opened = await f.assess(await f.seed());
        expect(opened.holdOpened).toBe(true);
        await f.decide(opened.caseId, "escalate");
        await f.decide(opened.caseId, "note");
        await f.decide(opened.caseId, "approve");
        expect((await f.owner.query("SELECT status FROM commerce_order_holds WHERE id=$1", [opened.holdId])).rows[0].status).toBe("released");
        const events = (await f.owner.query("SELECT event_type,actor_user_id,note FROM risk_case_events WHERE case_id=$1 ORDER BY occurred_at,id", [opened.caseId])).rows;
        expect(events).toHaveLength(4);
        expect(events.filter(e => e.actor_user_id === f.operator)).toHaveLength(3);
        expect(events.filter(e => e.note === "Synthetic note")).toHaveLength(3);
        if (f.native)
            await expect(f.decide(opened.caseId, "block")).rejects.toMatchObject({ code: "23505", message: "risk_case_already_closed" });
        else
            expect(await f.decide(opened.caseId, "block")).toMatchObject({ status: "blocked" });
        await f.decide(opened.caseId, "note");
    });
    it("block keeps its hold; unknown actors refuse and leave the case untouched", async () => {
        const opened = await f.assess(await f.seed(), { decision: "block" });
        await expect(f.decide(opened.caseId, "approve", undefined, randomUUID())).rejects.toMatchObject({ code: "23503" });
        expect((await f.owner.query("SELECT status FROM risk_manual_review_cases WHERE id=$1", [opened.caseId])).rows[0].status).toBe("open");
        await f.decide(opened.caseId, "block");
        expect((await f.owner.query("SELECT status FROM commerce_order_holds WHERE id=$1", [opened.holdId])).rows[0].status).toBe("active");
    });
    it("assessment and decision replay have no duplicate effects; timestamp/evidence fingerprint differs", async () => {
        const seed = await f.seed();
        const first = await f.assess(seed);
        expect(await f.assess(seed)).toEqual({ ...first, replayed: true });
        const changed = { at: "2026-01-15T12:00:01.000Z" };
        if (f.native)
            expect(await f.assess(seed, changed)).toEqual({ ...first, replayed: true });
        else
            await expect(f.assess(seed, changed)).rejects.toMatchObject({ code: "23505" });
        if (f.native)
            expect(await f.assess(seed, { evidence: { sanitized: true, changed: true } })).toEqual({ ...first, replayed: true });
        else
            await expect(f.assess(seed, { evidence: { sanitized: true, changed: true } })).rejects.toMatchObject({ code: "23505" });
        await expect(f.assess(seed, { decision: "block" })).rejects.toMatchObject({ code: "23505" });
        const key = `decide-${randomUUID()}`;
        const decided = await f.decide(first.caseId, "note", key);
        expect(await f.decide(first.caseId, "note", key)).toMatchObject({ replayed: true, caseId: decided.caseId });
        await expect(f.decide(first.caseId, "block", key)).rejects.toMatchObject({ code: "23505" });
        expect((await f.owner.query("SELECT count(*)::int AS n FROM risk_assessments WHERE order_id=$1", [seed.order])).rows[0].n).toBe(1);
        expect((await f.owner.query("SELECT count(*)::int AS n FROM risk_case_events WHERE case_id=$1", [first.caseId])).rows[0].n).toBe(2);
    });
    it("unpaid refuses; direct SQL and adapter payment evidence retain their rail-specific obligations", async () => {
        await expect(f.assess(await f.seed("pending_payment"))).rejects.toMatchObject({ code: "22023", message: "risk_assess_paid_order_not_paid" });
        const seed = await f.seed("paid", false);
        if (f.native) {
            expect(await f.assess(seed)).toMatchObject({ decision: "manual_review" });
            const ports = createPostgresRiskControlPorts(f.runtime, { mode: "hold" });
            expect(await ports.assessmentPort.assessPaidOrder({ orderUuid: seed.order, outboxEventId: "event-a", signal: new AbortController().signal })).toEqual({ kind: "retryable", reason: "risk_payment_intent_not_ready" });
        }
        else
            await expect(f.assess(seed)).rejects.toMatchObject({ code: "22023", message: "risk_assess_paid_order_payment_not_succeeded" });
        // Execute the packaged paid-order consumer on actual evidence and SQL. Managed RPC
        // transport is structural; fixture SELECTs/RPCs run under service_role, never owner.
        const paid = await f.seed();
        let port;
        if (f.native)
            port = createPostgresRiskControlPorts(f.runtime, { mode: "shadow" }).assessmentPort;
        else {
            const client: RiskSupabaseClient = { from(table) { const filters: unknown[] = []; const b = { select() { return b; }, eq(column: string, value: unknown) { filters.push([column, value]); return b; }, order() { return b; }, limit() { return b; }, async maybeSingle() { const sql = table === "commerce_orders" ? "SELECT * FROM commerce_orders WHERE id=$1" : "SELECT * FROM commerce_payment_intents WHERE order_id=$1 AND status='succeeded' ORDER BY updated_at DESC LIMIT 1"; return { data: (await f.runtime.query(sql, [paid.order])).rows[0] ?? null, error: null }; } }; return b; }, async rpc(name, args) { const keys = Object.keys(args); try {
                    return { data: (await f.runtime.query(`SELECT ${name}(${keys.map((k, i) => `${k} => $${i + 1}`).join(",")}) AS value`, keys.map(k => typeof args[k] === "object" && args[k] !== null ? JSON.stringify(args[k]) : args[k]))).rows[0].value, error: null };
                }
                catch (error) {
                    return { data: null, error };
                } } };
            port = createSupabaseOrderPaidRiskAssessmentPort({ client, mode: "shadow" });
        }
        const result = await port.assessPaidOrder({ orderUuid: paid.order, outboxEventId: "event-paid", signal: new AbortController().signal });
        expect(result, JSON.stringify(result)).toMatchObject({ kind: "allow" });
    });
    it("blocklist identity, inactivity and time/reason semantics remain distinct", async () => {
        const hash = randomUUID();
        if (f.native)
            await f.owner.query("INSERT INTO risk_blocklist_entries(subject_kind,subject_hash,reason_code,active) VALUES('email',$1,'manual_block',true),('device',$1,'inactive_reason',false)", [hash]);
        else
            await f.owner.query("INSERT INTO risk_blocklist_entries(subject_kind,subject_hash,reason_code,status,starts_at,expires_at) VALUES('email',$1,'manual_block','active',now()-interval '1 day',NULL),('device',$1,'inactive_reason','inactive',now()-interval '1 day',NULL),('ip',$1,'future_reason','active',now()+interval '1 day',NULL),('phone',$1,'expired_reason','active',now()-interval '2 days',now()-interval '1 day')", [hash]);
        const lookup = async (kind: string, value: string = hash) => (await f.runtime.query("SELECT risk_check_exact_blocklist($1) AS value", [JSON.stringify([{ subjectKind: kind, subjectHash: value }])])).rows[0].value;
        expect(await lookup("email")).toMatchObject({ blocked: true, reasonCodes: [f.native ? "manual_block" : "exact_blocklist_match"] });
        expect((await lookup("device")).blocked).toBe(false);
        expect((await lookup("email", "unmatched-synthetic-hash")).blocked).toBe(false);
        expect((await lookup("ip")).blocked).toBe(false);
        expect((await lookup("phone")).blocked).toBe(false);
        if (f.native)
            expect((await f.owner.query("SELECT column_name FROM information_schema.columns WHERE table_name='risk_blocklist_entries' AND column_name IN ('starts_at','expires_at')")).rows).toEqual([]);
    });
});

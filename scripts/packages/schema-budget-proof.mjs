/** Repository test tooling. Call with exports and requirements from installed artifacts. */
import assert from "node:assert/strict";
import { mock } from "node:test";

const WAITING_BUDGET_MS = 3000;
const flush = async () => { for (let turn = 0; turn < 12; turn++) await Promise.resolve(); };
const boundStrings = value => typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(boundStrings) : [];

export async function proveSchemaBudget({ schema, createSchemaProbe, checkReadiness, schemaObjectKey, makeInput }) {
  const modes = ["ready", "stalled-identity"];
  if (schema.objects.length) modes.push("slow", "malformed", "incomplete");
  const overload = schema.objects.find(object => object.kind === "function");
  if (overload) modes.push("wrong-overload");
  const results = [];
  for (const mode of modes) {
    mock.timers.enable({ apis: ["setTimeout", "Date"], now: 0 });
    const timerSet = globalThis.setTimeout, timerClear = globalThis.clearTimeout;
    const readinessTimers = new Set();
    globalThis.setTimeout = (callback, ms, ...args) => {
      const handle = timerSet(callback, ms, ...args);
      if (ms === WAITING_BUDGET_MS) readinessTimers.add(handle);
      return handle;
    };
    globalThis.clearTimeout = handle => { readinessTimers.delete(handle); return timerClear(handle); };
    // One delayed operation exceeds the default deadline, even if presence reads are batched.
    const latency = mode === "slow" ? WAITING_BUDGET_MS + 100 : 100;
    const database = "schema-budget-db";
    let tail = Promise.resolve(), identityReads = 0, pending = 0, releaseIdentity;
    let observationWork, observationSettled = false, observed, readiness, report, returnedAt;
    const queries = [];
    const advance = async ms => {
      for (let elapsed = 0; elapsed < ms; elapsed += 10) { await flush(); mock.timers.tick(Math.min(10, ms - elapsed)); }
      await flush();
    };
    try {
      const executor = { query: (text, values) => {
        queries.push({ text, values });
        pending++;
        const result = tail.then(() => new Promise(resolve => setTimeout(() => {
          pending--;
          resolve({ rows: [{ present: mode === "malformed" ? "invalid" : true }] });
        }, latency)));
        tail = result.then(() => undefined);
        return result;
      } };
      const probe = createSchemaProbe(executor, async requirement => {
        identityReads++;
        assert.equal(requirement.version, schema.version);
        assert.deepEqual(requirement.objects.map(schemaObjectKey).sort(), schema.objects.map(schemaObjectKey).sort());
        if (mode === "stalled-identity") await new Promise(resolve => { releaseIdentity = resolve; });
        else await new Promise(resolve => setTimeout(resolve, 250));
        return { database, version: requirement.version };
      });
      const schemaProbe = { observe: requirement => {
        observationWork = probe.observe(requirement).then(value => {
          observed = value;
          if (mode === "incomplete") return { ...value, objects: value.objects.slice(1) };
          if (mode === "wrong-overload") return { ...value, objects: value.objects.map(item => schemaObjectKey(item.object) === schemaObjectKey(overload)
            ? { ...item, object: { ...item.object, signature: overload.signature === "text" ? "boolean" : "text" } } : item) };
          return value;
        }).finally(() => { observationSettled = true; });
        return observationWork;
      } };
      const input = makeInput({ executor, schemaProbe, mode, database });
      assert.equal(input.probeTimeoutMs, undefined, "exercise the unchanged default waiting deadline");
      readiness = checkReadiness(input).then(value => { report = value; returnedAt = Date.now(); });
      await advance(WAITING_BUDGET_MS);
      assert.ok(report, `${mode}: readiness did not settle by the default deadline`);
      assert.equal(report.state, mode === "ready" ? "ready" : "unknown");
      if (["slow", "stalled-identity"].includes(mode)) assert.equal(returnedAt, WAITING_BUDGET_MS);
      if (mode === "ready") assert.ok(returnedAt < WAITING_BUDGET_MS);
      assert.equal(readinessTimers.size, 0, "readiness must clear its own deadline timer");
    } finally {
      // The losing observation still runs. Drain this owned fake queue before real timers/SQL.
      try {
        releaseIdentity?.();
        for (let turn = 0; observationWork && !observationSettled; turn++) {
          assert.ok(turn < 10000, "owned observation did not settle during fixture cleanup");
          await flush();
          mock.timers.runAll();
        }
        await observationWork;
        await tail;
        await readiness;
        assert.equal(pending, 0, "owned presence queue must be settled");
      } finally {
        globalThis.setTimeout = timerSet;
        globalThis.clearTimeout = timerClear;
        mock.timers.reset();
      }
    }
    assert.deepEqual(observed.objects.map(item => schemaObjectKey(item.object)).sort(), schema.objects.map(schemaObjectKey).sort());
    const values = queries.flatMap(query => boundStrings(query.values));
    for (const object of schema.objects.filter(object => object.kind === "function")) {
      assert.ok(values.includes(`${object.name}(${object.signature})`), `exact overload was not bound: ${schemaObjectKey(object)}`);
    }
    results.push({ mode, report, identityReads, presenceReads: queries.length, returnedAt });
    console.log(`Schema model ${mode}: identity=${identityReads}, presence=${queries.length}, returned=${returnedAt}ms, state=${report.state}`);
  }
  return results;
}

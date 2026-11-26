import { describe, expect, it } from "vitest";
import { z } from "zod";
import { parseStorefrontVerdict, storefrontVerdictJsonSchema, type StorefrontVerdict } from "../../src/lifecycle/index.js";
import { openSetExcept } from "../../src/lifecycle/storefrontVerdictSchema.js";

const digest = `sha256:${"ab".repeat(32)}`;

function browserVerdict(): StorefrontVerdict {
  return {
    formatVersion: 1,
    runId: "run-0001-clean",
    completedAt: "2025-06-01T00:00:00.000Z",
    scenario: "lost_response_reload",
    tier: "postgres_sandbox",
    profile: "default",
    channel: "browser_ui",
    width: 390,
    result: "passed",
    control: { kind: "block_read", negates: "awaiting_payment", applied: true },
    stimulus: { create: 3, read: 1 },
    steps: [
      {
        index: 0, run: "clean", phase: "arrange", action: "proceed_to_checkout", expectedAnchor: null,
        observedAnchors: ["action:place_order"], path: "/checkout", elapsedMs: 120, commands: [],
        ledger: { orders: 0, payableOrders: 0, holds: 0, attempts: 0, captures: 0 },
      },
      {
        index: 1, run: "clean", phase: "stimulus", action: "place_order", expectedAnchor: "state:awaiting_payment",
        observedAnchors: ["state:awaiting_payment", "action:continue_payment"], path: "/checkout", elapsedMs: 340,
        commands: [
          { operation: "create", ordinal: 0, key: { present: true, sameAs: null } },
          { operation: "create", ordinal: 1, key: { present: true, sameAs: 0 } },
        ],
        ledger: { orders: 1, payableOrders: 1, holds: 1, attempts: 0, captures: 0 },
      },
      {
        index: 0, run: "control", phase: "control", action: "place_order", expectedAnchor: null,
        observedAnchors: [], path: null, elapsedMs: 80, commands: [], ledger: null,
      },
    ],
    findings: [{
      code: "anchor_hidden", run: "clean", step: 1, field: "anchors.state.awaiting_payment",
      observed: "The anchor was covered.", cause: "Another element covers it.", fix: "Uncover the anchor.", recheck: "Run scenario lost_response_reload again.",
    }],
    build: {
      source: "claimed",
      packages: [{ name: "@openlup/platform", version: "1.0.0", integrity: "sha512-AbC+/x==" }, { name: "@openlup/core", version: "1.0.0" }],
      clients: [{ name: "web", digest }],
      proofFile: digest,
    },
    harness: {
      runnerVersion: "1.0.0", catalogueVersion: 1, adapter: { kind: "default", fields: [], digest: null },
      autoProgress: [], observer: "package", declaredOutcomes: ["declined", "settled"],
    },
    durations: { totalMs: 540, byPhase: { arrange: 120, stimulus: 340, control: 80 } },
  };
}

function parse(value: unknown) {
  return parseStorefrontVerdict(JSON.stringify(value));
}

function refusalOf(value: unknown) {
  const result = typeof value === "string" ? parseStorefrontVerdict(value) : parse(value);
  if (result.ok) throw new Error("expected a refusal");
  return result.refusal;
}

function expectFourParts(refusal: { observed: string; cause: string; fix: string; recheck: string }) {
  for (const part of [refusal.observed, refusal.cause, refusal.fix, refusal.recheck]) expect(part.length).toBeGreaterThan(0);
}

const schemaParser = z.fromJSONSchema(storefrontVerdictJsonSchema as z.core.JSONSchema.JSONSchema);

describe("parseStorefrontVerdict", () => {
  it("V1 round-trips a complete browser verdict", () => {
    const verdict = browserVerdict();
    expect(parseStorefrontVerdict(JSON.stringify(verdict))).toEqual({ ok: true, verdict });
  });

  it("V2 keeps unknown fields and values added later", () => {
    const verdict = browserVerdict() as Record<string, unknown> & StorefrontVerdict;
    verdict.fieldAddedLater = { nested: [1] };
    (verdict.steps[0] as Record<string, unknown>).fieldAddedLater = "step";
    (verdict.findings[0] as Record<string, unknown>).fieldAddedLater = "finding";
    verdict.result = "result_added_later";
    verdict.tier = "tier_added_later";
    verdict.steps[1]!.run = "run_added_later";
    verdict.build.source = "source_added_later";
    verdict.findings[0]!.code = "code_added_later";
    expect(parse(verdict)).toEqual({ ok: true, verdict });

    const other = browserVerdict() as Partial<StorefrontVerdict>;
    other.channel = "agent_protocol";
    delete other.width;
    expect(parse(other)).toEqual({ ok: true, verdict: other });
  });

  it("V3 refuses a browser_ui verdict without width at path width", () => {
    const verdict = browserVerdict() as Partial<StorefrontVerdict>;
    delete verdict.width;
    const refusal = refusalOf(verdict);
    expect(refusal.code).toBe("storefront_verdict_invalid");
    expect(refusal.observed).toBe("width");
    expectFourParts(refusal);
  });

  it("V4 names a deep error under browser_ui, not channel", () => {
    const verdict = browserVerdict();
    verdict.steps[0]!.ledger!.holds = -1;
    const refusal = refusalOf(verdict);
    expect(refusal.code).toBe("storefront_verdict_invalid");
    expect(refusal.observed).toBe("steps.0.ledger.holds");
  });

  it("V5 refuses an unknown format version by name", () => {
    const two = refusalOf({ ...browserVerdict(), formatVersion: 2 });
    expect(two.code).toBe("storefront_verdict_version_unsupported");
    expect(two.observed).toContain("2");
    expectFourParts(two);
    const text = refusalOf({ ...browserVerdict(), formatVersion: "1" });
    expect(text.code).toBe("storefront_verdict_version_unsupported");
    expect(text.observed).toContain('"1"');
  });

  it("V6 never throws on malformed input", () => {
    for (const text of ["{not json", "null", "[]", "42", JSON.stringify({ ...browserVerdict(), channel: "Browser UI" })]) {
      const refusal = refusalOf(text);
      expect(refusal.code).toBe("storefront_verdict_invalid");
      expectFourParts(refusal);
    }
    expect(refusalOf("[]").observed).toBe("(root)");
    expect(refusalOf(JSON.stringify({ ...browserVerdict(), channel: "Browser UI" })).observed).toBe("channel");
  });

  it("V11 requires harness.declaredOutcomes and keeps values added later", () => {
    const missing = browserVerdict() as StorefrontVerdict & { harness: Partial<StorefrontVerdict["harness"]> };
    delete missing.harness.declaredOutcomes;
    expect(refusalOf(missing).observed).toBe("harness.declaredOutcomes");
    for (const declaredOutcomes of [[], ["outcome_added_later"]]) {
      const verdict = browserVerdict();
      verdict.harness.declaredOutcomes = declaredOutcomes;
      expect(parse(verdict)).toEqual({ ok: true, verdict });
    }
  });
});

describe("storefrontVerdictJsonSchema", () => {
  const jsonValues: unknown[] = [null, true, 0, 1.5, "text", [], {}];

  function corpus(): unknown[] {
    const base = browserVerdict() as Record<string, unknown>;
    const out: unknown[] = [base, "not json", null, [], 42];
    const other = { ...base, channel: "agent_protocol" };
    delete (other as Record<string, unknown>).width;
    out.push(other, { ...base, channel: "Browser UI" }, { ...base, formatVersion: 2 }, { ...base, formatVersion: "1" });
    const deep = browserVerdict();
    deep.steps[0]!.ledger!.holds = -1;
    out.push(deep);
    for (const key of Object.keys(base)) {
      const removed = { ...base };
      delete removed[key];
      out.push(removed, { ...other, [key]: undefined });
      for (const value of jsonValues) out.push({ ...base, [key]: value }, { ...other, [key]: value });
    }
    for (const [section, record] of [["harness", base.harness], ["build", base.build], ["control", base.control]] as const) {
      for (const key of Object.keys(record as object)) {
        for (const value of [...jsonValues, undefined]) out.push({ ...base, [section]: { ...(record as object), [key]: value } });
      }
    }
    const firstStep = (base.steps as Record<string, unknown>[])[0]!;
    for (const key of Object.keys(firstStep)) {
      for (const value of [...jsonValues, undefined]) out.push({ ...base, steps: [{ ...firstStep, [key]: value }] });
    }
    return out;
  }

  it("V7 agrees with the parser over V1–V6 and a generated corpus", () => {
    const disagreements: string[] = [];
    for (const value of corpus()) {
      const text = typeof value === "string" ? value : JSON.stringify(value);
      let json: unknown;
      try { json = JSON.parse(text); } catch { json = Symbol("not json"); }
      const bySchema = schemaParser.safeParse(json).success;
      const byParser = parseStorefrontVerdict(text).ok;
      if (bySchema !== byParser) disagreements.push(text.slice(0, 200));
    }
    expect(disagreements).toEqual([]);
  });

  it("is frozen data, draft-07, with a const browser_ui branch", () => {
    expect(Object.isFrozen(storefrontVerdictJsonSchema)).toBe(true);
    expect(storefrontVerdictJsonSchema.$schema).toBe("http://json-schema.org/draft-07/schema#");
    const branches = storefrontVerdictJsonSchema.anyOf as { properties: Record<string, Record<string, unknown>>; required: string[] }[];
    expect(branches).toHaveLength(2);
    expect(Object.isFrozen(branches[0]!.properties)).toBe(true);
    expect(branches[0]!.properties.channel!.const).toBe("browser_ui");
    expect(branches[0]!.required).toContain("width");
    expect(branches[1]!.required).not.toContain("width");
    expect(JSON.stringify(storefrontVerdictJsonSchema)).not.toContain("(?!");
  });

  it("V8 excludes exactly browser_ui with a portable pattern", () => {
    const pattern = new RegExp(openSetExcept("browser_ui"));
    const branches = storefrontVerdictJsonSchema.anyOf as { properties: { channel: { pattern?: string } } }[];
    expect(branches[1]!.properties.channel.pattern).toBe(pattern.source);
    expect(pattern.test("browser_ui")).toBe(false);
    for (const accepted of ["browser_u", "browser_uix", "browser_ua", "crowser_ui", "agent_protocol", "b"]) expect(pattern.test(accepted), accepted).toBe(true);
    // Exhaustive over strings of length 1–11 whose character at position i is the
    // literal's character, `x` or `_` (a letter at position 0): every branch of
    // the alternation (shorter, longer, first difference at each position) is hit.
    const literal = "browser_ui";
    const grammar = /^[a-z][a-z0-9_]*$/;
    let checked = 0;
    const mismatches: string[] = [];
    const walk = (prefix: string, length: number) => {
      if (prefix.length === length) {
        checked += 1;
        if (grammar.test(prefix) && pattern.test(prefix) !== (prefix !== literal)) mismatches.push(prefix);
        return;
      }
      const position = prefix.length;
      const choices = new Set(position === 0 ? [literal[0]!, "x"] : [literal[position] ?? "u", "x", "_"]);
      for (const choice of choices) walk(prefix + choice, length);
    };
    for (let length = 1; length <= 11; length += 1) walk("", length);
    expect(mismatches).toEqual([]);
    expect(checked).toBeGreaterThan(100_000);
    // Each single substitution from the full alphabet {b,r,o,w,s,e,_,u,i,x} at each position.
    for (let position = 0; position < literal.length; position += 1) {
      for (const character of "browse_uix") {
        const candidate = literal.slice(0, position) + character + literal.slice(position + 1);
        if (grammar.test(candidate)) expect(pattern.test(candidate), candidate).toBe(candidate !== literal);
      }
    }
  });

  it("V10 declares no body or token field, and a command key is presence and sameness only", () => {
    const names: string[] = [];
    const walk = (node: unknown) => {
      if (Array.isArray(node)) return node.forEach(walk);
      if (node === null || typeof node !== "object") return;
      const record = node as Record<string, unknown>;
      if (record.properties && typeof record.properties === "object") names.push(...Object.keys(record.properties));
      Object.values(record).forEach(walk);
    };
    walk(storefrontVerdictJsonSchema);
    expect(names).not.toContain("body");
    expect(names).not.toContain("token");
    const branches = storefrontVerdictJsonSchema.anyOf as { properties: { steps: { items: { properties: { commands: { items: { properties: { key: { properties: object } } } } } } } } }[];
    for (const branch of branches) expect(Object.keys(branch.properties.steps.items.properties.commands.items.properties.key.properties).sort()).toEqual(["present", "sameAs"]);
  });
});

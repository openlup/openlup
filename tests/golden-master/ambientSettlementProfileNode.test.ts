import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { COMMERCE_CONTRACT_VERSION } from "../../src/domains/commerce/types.js";
import type { CreateQuoteResponse } from "../../src/domains/commerce/contracts.js";

/**
 * D1: the ambient settlement profile has to reach a plain server process.
 *
 * `src/lib/currency/platformCurrency.ts` resolves its ambient profile from the
 * environment record a bundler substitutes. A serverless function, a cron and a
 * worker have no such record, so before this wave the ambient currency schema —
 * which every money node of every contract is built on — answered for the
 * platform default no matter what the deployment was configured to settle in,
 * and refused the configured currency on the server while the *reader* in the
 * same process returned it. The default deployment worked by coincidence: the
 * ambient default happened to equal the configuration.
 *
 * Three things are proved here, in falsifying order:
 *
 *   1. the plain-process behaviour, in an actual plain process, because that is
 *      the one condition this suite cannot otherwise create — vitest runs under
 *      a bundler transform, where `import.meta.env` exists and the defect is
 *      invisible;
 *   2. the contract consequence, on the order-draft snapshot that first
 *      surfaced it;
 *   3. that no entrypoint able to reach the currency module was left out, by
 *      walking the import graph rather than by having read the list carefully.
 */

const REPO_ROOT = resolve(import.meta.dirname, "../..");
const CURRENCY_MODULE = join(REPO_ROOT, "src/lib/currency/platformCurrency.ts");
const BOOTSTRAP_CALL = "bootstrapAmbientSettlementProfile";

/**
 * ISO 4217's code reserved for testing. Used instead of any real alternative so
 * the fixture below denominates money in something no deployment settles in and
 * no readiness scanner counts.
 */
const TEST_CURRENCY = "XTS";

describe("a plain server process can be told what it settles in", () => {
  /**
   * The live boot. Everything else in this file runs under the bundler transform
   * that hides the defect, so this arm spawns a real process with no such
   * transform, hands it a configured currency, and reads back four facts: that
   * the bundled record is genuinely absent, that the reader sees the
   * configuration, what the ambient schema says before initialisation, and what
   * it says after.
   *
   * The before-arm is the regression: it is the exact state every deployed
   * function was in, and it stays asserted so a later change that makes
   * initialisation implicit has to say so here.
   */
  it("refuses the configured currency until initialised, then accepts it", () => {
    const probeDir = mkdtempSync(join(tmpdir(), "ambient-settlement-"));
    // `.mts` rather than `.ts`: the probe lives outside the repository, where
    // nothing declares a module type, and the defect it reproduces only exists
    // in a module process.
    const probe = join(probeDir, "probe.mts");
    writeFileSync(
      probe,
      [
        `const currency = ${JSON.stringify(pathToFileURL(CURRENCY_MODULE).href)};`,
        `const mod = await import(currency);`,
        `const bundleEnvPresent =`,
        `  (import.meta as unknown as { env?: unknown }).env !== undefined;`,
        `const before = mod.platformCurrencySchema.safeParse(process.env.COMMERCE_SETTLEMENT_CURRENCY);`,
        `mod.initAmbientSettlementProfile(mod.readSettlementProfile(process.env));`,
        `const after = mod.platformCurrencySchema.safeParse(process.env.COMMERCE_SETTLEMENT_CURRENCY);`,
        `console.log(JSON.stringify({`,
        `  bundleEnvPresent,`,
        `  readerSees: mod.readSettlementProfile(process.env).defaultCurrency,`,
        `  ambientBefore: before.success`,
        `    ? "accepted"`,
        `    : before.error.issues.map((issue: { message: string }) => issue.message).join(","),`,
        `  ambientAfter: after.success ? "accepted" : "refused",`,
        `  defaultAfter: mod.platformCurrencySchema`,
        `    .safeParse(mod.PLATFORM_DEFAULT_CURRENCY).success ? "accepted" : "refused",`,
        `}));`,
      ].join("\n"),
      "utf8",
    );

    const stdout = execFileSync(
      process.execPath,
      ["--conditions=core-source", "--import", "tsx", probe],
      {
        cwd: REPO_ROOT,
        encoding: "utf8",
        env: { ...process.env, COMMERCE_SETTLEMENT_CURRENCY: TEST_CURRENCY },
      },
    );

    expect(JSON.parse(stdout.trim())).toEqual({
      // The defect's root cause, asserted rather than described: there is no
      // bundled environment record on this side of the wire.
      bundleEnvPresent: false,
      readerSees: TEST_CURRENCY,
      // What every deployed function did with a configured currency.
      ambientBefore: "currency_not_settlement_currency",
      ambientAfter: "accepted",
      // And the platform default stops being accepted, because a deployment
      // settles in one currency rather than in two.
      defaultAfter: "refused",
    });
  });
});

describe("the ambient profile follows one initialisation per process", () => {
  beforeEach(() => {
    // The ambient profile is process state by construction, so each case needs
    // its own copy of the module graph rather than its own object.
    vi.resetModules();
  });

  it("answers for the platform default when nothing initialises it", async () => {
    const { platformCurrencySchema, PLATFORM_DEFAULT_CURRENCY, ambientSettlementProfile } =
      await import("../../src/lib/currency/platformCurrency.js");

    // Unchanged behaviour, which is the whole guarantee for a deployment that
    // settles in the platform's own currency: it cannot observe this wave.
    expect(ambientSettlementProfile.defaultCurrency).toBe(PLATFORM_DEFAULT_CURRENCY);
    expect(platformCurrencySchema.safeParse(PLATFORM_DEFAULT_CURRENCY).success).toBe(true);
    expect(platformCurrencySchema.safeParse(TEST_CURRENCY).success).toBe(false);
  });

  it("moves the ambient answer, and the schema with it", async () => {
    const currency = await import("../../src/lib/currency/platformCurrency.js");
    currency.initAmbientSettlementProfile(
      currency.readSettlementProfile({ COMMERCE_SETTLEMENT_CURRENCY: TEST_CURRENCY }),
    );

    expect(currency.ambientSettlementProfile.defaultCurrency).toBe(TEST_CURRENCY);
    expect(currency.platformCurrencySchema.safeParse(TEST_CURRENCY).success).toBe(true);
    expect(currency.platformCurrencySchema.safeParse(currency.PLATFORM_DEFAULT_CURRENCY).success)
      .toBe(false);
  });

  it("repeats one environment's answer without complaint", async () => {
    const currency = await import("../../src/lib/currency/platformCurrency.js");
    const env = { COMMERCE_SETTLEMENT_CURRENCY: TEST_CURRENCY };

    // Two roots in one process reading the same environment is ordinary: the
    // node host states it for its scheduler and its dispatcher states it again.
    currency.initAmbientSettlementProfile(currency.readSettlementProfile(env));
    expect(() => currency.initAmbientSettlementProfile(currency.readSettlementProfile(env)))
      .not.toThrow();
    expect(currency.ambientSettlementProfile.defaultCurrency).toBe(TEST_CURRENCY);
  });

  it("refuses to hold two answers at once", async () => {
    const currency = await import("../../src/lib/currency/platformCurrency.js");
    currency.initAmbientSettlementProfile(
      currency.readSettlementProfile({ COMMERCE_SETTLEMENT_CURRENCY: TEST_CURRENCY }),
    );

    // Tolerating this would make "is this payload's currency accepted" depend on
    // which module loaded first, which is worse than either answer being wrong.
    const conflicting = currency.readSettlementProfile({});
    expect(() => currency.initAmbientSettlementProfile(conflicting))
      .toThrow(currency.ConflictingAmbientSettlementProfileError);
    // And the first answer stands rather than being half-replaced.
    expect(currency.ambientSettlementProfile.defaultCurrency).toBe(TEST_CURRENCY);

    // A profile that differs in something other than the currency is still two
    // answers: the region selects which price list the resolver reads.
    const otherRegion = currency.readSettlementProfile({
      COMMERCE_SETTLEMENT_CURRENCY: TEST_CURRENCY,
      COMMERCE_SETTLEMENT_REGION: "DE",
    });
    expect(() => currency.initAmbientSettlementProfile(otherRegion))
      .toThrow(currency.ConflictingAmbientSettlementProfileError);
  });

  it("leaves an injected schema alone", async () => {
    const currency = await import("../../src/lib/currency/platformCurrency.js");
    // A caller that named its profile gets an answer nothing else can move —
    // which is what makes the ambient binding safe to make movable at all.
    const pinned = currency.createPlatformCurrencySchema(
      currency.readSettlementProfile({}),
    );

    currency.initAmbientSettlementProfile(
      currency.readSettlementProfile({ COMMERCE_SETTLEMENT_CURRENCY: TEST_CURRENCY }),
    );

    expect(pinned.safeParse(currency.PLATFORM_DEFAULT_CURRENCY).success).toBe(true);
    expect(pinned.safeParse(TEST_CURRENCY).success).toBe(false);
  });
});

describe("the order-draft snapshot stops refusing the configured currency", () => {
  beforeEach(() => {
    vi.resetModules();
  });

  /**
   * The shape from the reproduction. `orderDraftSnapshotSchema.currency` and
   * every `commerceMoneySchema` node beneath it are the ambient schema, so a
   * configured deployment used to lose the draft at
   * `server/domains/commerce/orderDraftRpcPayload.ts` — before the request ever
   * reached the database gate, and therefore without the named refusal that gate
   * would have produced.
   */
  it("parses a draft denominated in the configured currency, and refuses it before", async () => {
    const currency = await import("../../src/lib/currency/platformCurrency.js");
    currency.initAmbientSettlementProfile(
      currency.readSettlementProfile({ COMMERCE_SETTLEMENT_CURRENCY: TEST_CURRENCY }),
    );
    const initialised = await import("../../src/domains/commerce/orderDraftSnapshotContracts.js");

    // The builder validates on the way out, so an uninitialised process cannot
    // even produce this payload - which is the defect stated once more, from the
    // producing side.
    const snapshot = initialised.createOrderDraftSnapshotFromQuoteSnapshot(
      quoteResponseIn(TEST_CURRENCY),
    );
    expect(initialised.orderDraftSnapshotSchema.safeParse(snapshot).success).toBe(true);

    // The same bytes, offered to a process that was never told what it settles
    // in: this is what every deployed function did with a configured currency.
    vi.resetModules();
    const uninitialised = await import("../../src/domains/commerce/orderDraftSnapshotContracts.js");
    const refused = uninitialised.orderDraftSnapshotSchema.safeParse(structuredClone(snapshot));

    expect(refused.success).toBe(false);
    expect(refused.error?.issues.map((issue) => issue.message))
      .toContain("currency_not_settlement_currency");
  });

  it("still parses a draft in the platform default when nothing initialises", async () => {
    const { PLATFORM_DEFAULT_CURRENCY } =
      await import("../../src/lib/currency/platformCurrency.js");
    const { createOrderDraftSnapshotFromQuoteSnapshot, orderDraftSnapshotSchema } =
      await import("../../src/domains/commerce/orderDraftSnapshotContracts.js");

    const snapshot = createOrderDraftSnapshotFromQuoteSnapshot(
      quoteResponseIn(PLATFORM_DEFAULT_CURRENCY),
    );

    expect(orderDraftSnapshotSchema.safeParse(snapshot).success).toBe(true);
  });
});

/**
 * The covered set is computed, not chosen.
 *
 * The failure this forbids is a partial fix: the initialiser lands, most lanes
 * work, and one entrypoint is missed — so a configured deployment refuses money
 * on exactly one path and the symptom looks like bad data rather than missing
 * configuration. Walking the runtime import graph makes "which entrypoints can
 * reach the currency module" a measurement, so an entrypoint that starts
 * reaching it later fails here instead of in production.
 */
describe("every entrypoint that can reach the currency module initialises", () => {
  /**
   * The two serverless BFF entrypoints hold no logic of their own: one is a
   * route table, the other a URL rewrite, and both hand off to `dispatch`, which
   * states the profile for every mounted route. Asserted below rather than
   * assumed, so the delegation cannot quietly stop being true.
   */
  const DELEGATES_TO_DISPATCH = ["api/bff/[...path].ts", "api/bff-router.ts"];
  const DISPATCHER = "server/runtime/bffDispatch.ts";

  it("names the dispatcher as the BFF entrypoints' initialiser", () => {
    expect(readFileSync(join(REPO_ROOT, DISPATCHER), "utf8")).toContain(`${BOOTSTRAP_CALL}(`);
  });

  it("leaves no reaching entrypoint uninitialised", () => {
    const entrypoints = [
      // Everything a serverless function boots from, minus the underscore-prefixed
      // job modules, which are not routable and are only ever imported by one.
      ...sourceFilesUnder(join(REPO_ROOT, "api"))
        .filter((file) => !relative(REPO_ROOT, file).startsWith("api/_cron/")),
      ...sourceFilesUnder(join(REPO_ROOT, "server/workers")),
      join(REPO_ROOT, "server/runtime/serve.node.ts"),
    ];

    const reaching = entrypoints
      .filter((file) => reachesCurrencyModule(file))
      .map((file) => relative(REPO_ROOT, file));

    // A walk that reached nothing would pass the assertion below while proving
    // nothing; the BFF entrypoints alone are two of them.
    expect(reaching.length).toBeGreaterThanOrEqual(DELEGATES_TO_DISPATCH.length + 1);

    const uninitialised = reaching
      .filter((file) => !DELEGATES_TO_DISPATCH.includes(file))
      .filter((file) => !readFileSync(join(REPO_ROOT, file), "utf8").includes(`${BOOTSTRAP_CALL}(`));

    expect(uninitialised).toEqual([]);
  });
});

/** Source files a runtime actually loads: no tests, no declaration files. */
function sourceFilesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return sourceFilesUnder(path);
    return /\.tsx?$/.test(entry.name) && !/\.test\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

/**
 * Does this module's runtime import graph contain the currency module?
 *
 * Type-only imports are skipped because they are erased before the process runs,
 * so counting them would demand initialisation from entrypoints that never load
 * a line of the module.
 */
function reachesCurrencyModule(entry: string): boolean {
  const seen = new Set<string>();
  const pending = [entry];
  while (pending.length > 0) {
    const file = pending.pop()!;
    if (seen.has(file)) continue;
    seen.add(file);
    if (file === CURRENCY_MODULE) return true;
    pending.push(...runtimeImportsOf(file));
  }
  return false;
}

const IMPORT_STATEMENT =
  /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[^'"();]*?\sfrom\s+)?["']([^"']+)["']/g;

function runtimeImportsOf(file: string): string[] {
  let source: string;
  try {
    source = readFileSync(file, "utf8");
  } catch {
    return [];
  }
  return [...source.matchAll(IMPORT_STATEMENT)]
    .filter((match) => !/\b(?:import|export)\s+type\b/.test(match[0]))
    .map((match) => resolveSpecifier(file, match[1]!))
    .filter((resolved): resolved is string => resolved !== null);
}

function resolveSpecifier(from: string, specifier: string): string | null {
  if (specifier.startsWith("@/")) return firstExistingFile(join(REPO_ROOT, "src", specifier.slice(2)));
  if (!specifier.startsWith(".")) return null;
  return firstExistingFile(resolve(dirname(from), specifier));
}

function firstExistingFile(base: string): string | null {
  const withoutJs = base.replace(/\.jsx?$/, "");
  const candidates = [
    `${withoutJs}.ts`,
    `${withoutJs}.tsx`,
    base,
    `${base}.ts`,
    `${base}.tsx`,
    join(base, "index.ts"),
    join(base, "index.tsx"),
  ];
  return candidates.find((candidate) => existsSync(candidate) && statSync(candidate).isFile())
    ?? null;
}

/**
 * The reproduction's cart, denominated in whichever currency the case is about.
 *
 * Every money node takes the same code, because a snapshot mixing two is refused
 * by an invariant that has nothing to do with this wave and would mask the
 * result. The amounts are the existing contract fixture's, so the totals
 * reconcile and the only thing under test is the currency.
 */
function quoteResponseIn(currency: string): CreateQuoteResponse {
  const money = (amountMinor: number) => ({ amountMinor, currency });
  return {
    contractVersion: COMMERCE_CONTRACT_VERSION,
    quote: {
      currency,
      taxIncluded: true,
      lines: [
        {
          sku: "SKU-LINE-400G",
          productSlug: "line",
          quantity: 2,
          unitPriceGross: money(1490),
          lineSubtotalGross: money(2980),
          tax: {
            included: true,
            country: "DE",
            category: "pet_food",
            vatRateBps: 800,
            legalBasis: "Reduced rate, test fixture",
            netAmount: money(2759),
            vatAmount: money(221),
            grossAmount: money(2980),
          },
        },
      ],
      discounts: [],
      context: {
        mode: "subscription",
        cadenceDays: 21,
        sizeConstraint: {
          kind: "feeding_days",
          value: 21,
          petId: "pet-rex",
          dailyKcalOverride: 328,
        },
        promoCodes: [],
        petId: "pet-rex",
        petProfileContext: {
          petId: "pet-rex",
          ageBand: "adult",
          weightKg: 12,
          activityLevel: "normal",
          bcs: "ideal",
          allergenSlugs: ["chicken"],
          dailyKcalOverride: 328,
        },
      },
      subtotalGross: money(2980),
      discountTotalGross: money(0),
      totalGross: money(2980),
      netTotal: money(2759),
      taxTotal: money(221),
    },
  };
}

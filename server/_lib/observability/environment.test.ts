import { describe, expect, it } from "vitest";
import {
  APPLICATION_ENVIRONMENT_KEY,
  HOST_ENVIRONMENT_KEY,
  LEGACY_APPLICATION_ENVIRONMENT_KEY,
  deployedRuntimeAssumed,
  invalidApplicationEnvironmentMarkerPresent,
  noopSettlementAllowed,
  productionEnvironmentMarkerPresent,
  productionRolloutConfirmed,
  readObservedEnvironment,
  unlabelledEnvironment,
} from "./environment.js";

const stagingOnProductionHost = {
  openlup_ENVIRONMENT: "staging",
  VERCEL_ENV: "production",
} as const;

describe("readObservedEnvironment", () => {
  it.each(["production", "staging"] as const)("preserves legacy %s precedence over the hosted deployment class", (environment) => {
    expect(readObservedEnvironment({
      openlup_ENVIRONMENT: ` ${environment.toUpperCase()} `,
      VERCEL_ENV: "preview",
    }))
      .toBe(environment);
  });

  it.each(["production", "preview", "development"] as const)("uses Vercel %s without an explicit environment", (environment) => {
    expect(readObservedEnvironment({ [HOST_ENVIRONMENT_KEY]: environment })).toBe(environment);
  });

  it("preserves legacy fallback from an unrecognized value to a recognized hosted environment", () => {
    expect(LEGACY_APPLICATION_ENVIRONMENT_KEY).toBe("openlup_ENVIRONMENT");
    expect(HOST_ENVIRONMENT_KEY).toBe("VERCEL_ENV");
    expect(readObservedEnvironment({
      [LEGACY_APPLICATION_ENVIRONMENT_KEY]: "test",
      [HOST_ENVIRONMENT_KEY]: "production",
    })).toBe("production");
    expect(readObservedEnvironment({
      [LEGACY_APPLICATION_ENVIRONMENT_KEY]: "test",
      [HOST_ENVIRONMENT_KEY]: "custom",
    })).toBe("unknown");
  });

  it.each(["production", "staging", "preview", "development"] as const)(
    "uses the neutral %s application class on bare Node and makes it authoritative",
    (environment) => {
      expect(readObservedEnvironment({
        [APPLICATION_ENVIRONMENT_KEY]: ` ${environment.toUpperCase()} `,
        [LEGACY_APPLICATION_ENVIRONMENT_KEY]: environment === "production" ? "staging" : "production",
        [HOST_ENVIRONMENT_KEY]: environment === "production" ? "preview" : "production",
      })).toBe(environment);
    },
  );

  it("treats an explicit invalid neutral class as unknown instead of falling through", () => {
    const env = {
      [APPLICATION_ENVIRONMENT_KEY]: "prod-ish",
      [LEGACY_APPLICATION_ENVIRONMENT_KEY]: "production",
      [HOST_ENVIRONMENT_KEY]: "production",
    };
    expect(readObservedEnvironment(env)).toBe("unknown");
    expect(invalidApplicationEnvironmentMarkerPresent(env)).toBe(true);
    expect(productionEnvironmentMarkerPresent(env)).toBe(true);
    expect(unlabelledEnvironment(env)).toBe(false);
  });

  it("treats an absent or blank neutral marker as compatibility fallback", () => {
    expect(readObservedEnvironment({
      [APPLICATION_ENVIRONMENT_KEY]: "   ",
      [LEGACY_APPLICATION_ENVIRONMENT_KEY]: "staging",
      [HOST_ENVIRONMENT_KEY]: "production",
    })).toBe("staging");
    expect(invalidApplicationEnvironmentMarkerPresent({
      [APPLICATION_ENVIRONMENT_KEY]: "   ",
    })).toBe(false);
  });

  it("preserves explicit staging observability when the host deployment class says production", () => {
    expect(readObservedEnvironment(stagingOnProductionHost)).toBe("staging");
    expect(noopSettlementAllowed(stagingOnProductionHost)).toBe(false);
  });
});

describe("noopSettlementAllowed", () => {
  it.each([
    ["production", { VERCEL_ENV: "production" }, false],
    ["preview", { VERCEL_ENV: "preview" }, true],
    ["development", { VERCEL_ENV: "development" }, true],
    ["an empty environment", {}, false],
  ] as const)("re-homes the %s environment expectation", (_environment, env, expected) => {
    expect(noopSettlementAllowed(env)).toBe(expected);
  });

  it.each([
    ["staging", { openlup_ENVIRONMENT: "staging" }],
    ["NODE_ENV=test", { NODE_ENV: "test" }],
    ["LOCAL_BFF=1", { LOCAL_BFF: "1" }],
  ] as const)("allows an explicit non-production capability: %s", (_capability, env) => {
    expect(noopSettlementAllowed(env)).toBe(true);
  });

  it.each([
    { openlup_ENVIRONMENT: "production", NODE_ENV: "test" },
    { openlup_ENVIRONMENT: "production", LOCAL_BFF: "1" },
    { ...stagingOnProductionHost, LOCAL_BFF: "1" },
  ])("refuses production even when a local capability marker is present", (env) => {
    expect(noopSettlementAllowed(env)).toBe(false);
  });
});

// The origin-protection seam behind both magic-link endpoints
// (server/bff/customers/magic-link.ts, server/bff/admin/platform/magic-link.ts).
// The matrix runs every environment value on a hosting-provider-classed env and
// on a bare Node env, because the defect being closed was exactly that the
// hosted column carried the protection and the bare-Node column silently lost
// it. The keys are built once, so each spelling stays in one place. The
// separate case of a bare hosting flag with no environment class is pinned at
// route level, in both magic-link suites.
const hostClass = (value: string) => ({ [HOST_ENVIRONMENT_KEY]: value });
const appClass = (value: string) => ({ [APPLICATION_ENVIRONMENT_KEY]: value });
const legacyAppClass = (value: string) => ({ [LEGACY_APPLICATION_ENVIRONMENT_KEY]: value });

type MatrixRow = readonly [
  label: string,
  env: Record<string, string>,
  productionMarker: boolean,
  unlabelled: boolean,
  deployed: boolean,
];

const originProtectionMatrix: readonly MatrixRow[] = [
  ["hosted production", hostClass("production"), true, false, true],
  ["hosted staging application on a production host", { ...stagingOnProductionHost }, true, false, true],
  ["hosted preview", hostClass("preview"), false, false, true],
  ["hosted development", hostClass("development"), false, false, true],
  ["hosted with an invalid environment class", hostClass("prod-ish"), false, true, true],
  ["bare node production", appClass("production"), true, false, true],
  ["bare node staging", appClass("staging"), false, false, true],
  ["bare node preview", appClass("preview"), false, false, true],
  ["bare node development", appClass("development"), false, false, true],
  ["bare node with a missing environment", {}, false, true, true],
  ["bare node with an invalid environment", appClass("produkcja"), false, true, true],
  ["legacy bare node production", legacyAppClass("production"), true, false, true],
  ["legacy bare node staging", legacyAppClass("staging"), false, false, true],
  ["legacy bare node preview remains unrecognized", legacyAppClass("preview"), false, true, true],
  ["legacy bare node development remains unrecognized", legacyAppClass("development"), false, true, true],
  ["legacy invalid still falls through to host preview", {
    ...legacyAppClass("produkcja"),
    ...hostClass("preview"),
  }, false, false, true],
  ["bare node test rig", { NODE_ENV: "test" }, false, false, false],
  ["bare node local rig", { LOCAL_BFF: "1" }, false, false, false],
  ["bare node production declared on a test rig", { ...appClass("production"), NODE_ENV: "test" }, true, false, true],
];

describe("origin-protection environment matrix", () => {
  it.each(originProtectionMatrix)(
    "classifies %s",
    (_label, env, productionMarker, unlabelled, deployed) => {
      expect(productionEnvironmentMarkerPresent(env)).toBe(productionMarker);
      expect(unlabelledEnvironment(env)).toBe(unlabelled);
      expect(deployedRuntimeAssumed(env)).toBe(deployed);
    },
  );

  it("never leaves an environment both production-marked and unlabelled", () => {
    for (const [, env] of originProtectionMatrix) {
      expect(productionEnvironmentMarkerPresent(env) && unlabelledEnvironment(env)).toBe(false);
    }
  });

  it("treats an unlabelled runtime as deployed, so a loopback origin is refused", () => {
    expect(unlabelledEnvironment({})).toBe(true);
    expect(deployedRuntimeAssumed({})).toBe(true);
  });
});

// The admission seam behind the hidden-sandbox fence over customer mutations
// (server/_lib/hiddenSandboxPreviewGuard.ts) and behind the reference store rail
// (server/adapters/localReferenceStoreAdapter.ts). Two keys, in this order: the
// runtime must SAY it is production, and its operator must have BAKED the
// confirmation. The row that gave this predicate its reason to exist is
// "declared production plus a confirmation": before it, a deployment could carry
// both keys and still be refused, because the door tested one vendor's spelling
// of the first one.
const confirmed = { PRODUCTION_ROLLOUT_CONFIRMED: "true" } as const;

const rolloutConfirmationMatrix: readonly (readonly [string, Record<string, string>, boolean])[] = [
  ["nothing declared", {}, false],
  ["a confirmation with nothing to confirm", { ...confirmed }, false],
  ["declared production, no confirmation", appClass("production"), false],
  ["declared production plus a confirmation", { ...appClass("production"), ...confirmed }, true],
  ["legacy declared production plus a confirmation", { ...legacyAppClass("production"), ...confirmed }, true],
  ["hosted production, no confirmation", hostClass("production"), false],
  ["hosted production plus a confirmation", { ...hostClass("production"), ...confirmed }, true],
  ["declared staging plus a confirmation", { ...appClass("staging"), ...confirmed }, false],
  ["hosted preview plus a confirmation", { ...hostClass("preview"), ...confirmed }, false],
  ["hosted staging application on a production host, confirmed", { ...stagingOnProductionHost, ...confirmed }, true],
  ["a local rig that also declares production and confirms it", { ...appClass("production"), ...confirmed, LOCAL_BFF: "1" }, true],
  ["a local rig", { LOCAL_BFF: "1" }, false],
  ["a confirmation spelled anything but true", { ...appClass("production"), PRODUCTION_ROLLOUT_CONFIRMED: "yes" }, false],
  ["a confirmation spelled false", { ...appClass("production"), PRODUCTION_ROLLOUT_CONFIRMED: "false" }, false],
];

describe("production rollout confirmation", () => {
  it.each(rolloutConfirmationMatrix)("classifies %s", (_label, env, expected) => {
    expect(productionRolloutConfirmed(env)).toBe(expected);
  });

  it("never admits a runtime the origin backstop calls unlabelled", () => {
    for (const [, env] of rolloutConfirmationMatrix) {
      if (unlabelledEnvironment(env)) expect(productionRolloutConfirmed(env)).toBe(false);
    }
  });

  it("is exactly the production marker AND the confirmation, on every origin-protection row", () => {
    for (const [, env] of originProtectionMatrix) {
      expect(productionRolloutConfirmed(env)).toBe(false);
      expect(productionRolloutConfirmed({ ...env, ...confirmed }))
        .toBe(productionEnvironmentMarkerPresent(env));
    }
  });
});

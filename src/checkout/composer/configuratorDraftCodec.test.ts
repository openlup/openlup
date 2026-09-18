/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it } from "vitest";

import { createPersistedState } from "@/lib/persistentCommerceState";
import {
  CONFIGURATOR_DRAFT_TTL_MS,
  CONFIGURATOR_DRAFT_VERSION,
  createConfiguratorDraftPersistedState,
  getConfiguratorDraftStorageKey,
  PUBLIC_CONFIGURATOR_DRAFT_SCOPE,
  serializeConfiguratorIntent,
  type ConfiguratorDraftEnvelope,
  type ConfiguratorDraftIntent,
} from "./configuratorDraftCodec";
import {
  resolveConfiguratorDraftSteps,
  withConfiguratorStepIds,
} from "./configuratorDraftStepIds";
import { defaultConfiguratorFormData } from "./configuratorFormStore";

const KEY = getConfiguratorDraftStorageKey(PUBLIC_CONFIGURATOR_DRAFT_SCOPE);

function intent(): ConfiguratorDraftIntent {
  return serializeConfiguratorIntent(
    { ...defaultConfiguratorFormData, promoCodes: ["KEEPME"] },
    PUBLIC_CONFIGURATOR_DRAFT_SCOPE,
  );
}

/** Write a raw envelope the way a bundle of some other vintage would have. */
function seedStoredDraft(data: Record<string, unknown>, savedAt = Date.now()): void {
  localStorage.setItem(
    KEY,
    JSON.stringify({ v: CONFIGURATOR_DRAFT_VERSION, savedAt, data }),
  );
}

function storedData(): Record<string, unknown> {
  return JSON.parse(localStorage.getItem(KEY) ?? "{}").data as Record<string, unknown>;
}

describe("configurator draft step ids — dual-write", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("writes the id alongside the number it was derived from", () => {
    const enriched = withConfiguratorStepIds({ form: intent(), step: 3, maxStep: 5 });

    expect(enriched.step).toBe(3);
    expect(enriched.maxStep).toBe(5);
    expect(enriched.stepId).toBe("flavors");
    expect(enriched.maxStepId).toBe("package");
  });

  it("recomputes the ids instead of carrying a stale pair forward", () => {
    const stale: ConfiguratorDraftEnvelope = {
      form: intent(),
      step: 5,
      maxStep: 5,
      stepId: "allergies",
      maxStepId: "allergies",
    };

    expect(withConfiguratorStepIds(stale)).toMatchObject({
      step: 5,
      maxStep: 5,
      stepId: "package",
      maxStepId: "package",
    });
  });

  it("omits the id for a number that addresses no step", () => {
    const enriched = withConfiguratorStepIds({ form: intent(), step: 99, maxStep: 0 });

    expect(enriched.step).toBe(99);
    expect(enriched.maxStep).toBe(0);
    expect(enriched.stepId).toBeUndefined();
    expect(enriched.maxStepId).toBeUndefined();
  });

  it("persists both encodings on every save", () => {
    const store = createConfiguratorDraftPersistedState(KEY);

    expect(store.save({ form: intent(), step: 4, maxStep: 6 })).toBe("saved");

    expect(storedData()).toMatchObject({
      step: 4,
      maxStep: 6,
      stepId: "your_data",
      maxStepId: "address",
    });
  });
});

describe("configurator draft step ids — read precedence", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("resolves a pre-change envelope from its number, untouched", () => {
    const form = intent();

    expect(resolveConfiguratorDraftSteps({ form, step: 2, maxStep: 4 })).toEqual({
      form,
      step: 2,
      maxStep: 4,
    });
  });

  it("prefers the id over a disagreeing number", () => {
    const resolved = resolveConfiguratorDraftSteps({
      form: intent(),
      step: 2,
      maxStep: 2,
      stepId: "package",
      maxStepId: "address",
    });

    expect(resolved.step).toBe(5);
    expect(resolved.maxStep).toBe(6);
  });

  it("falls back to the number when the id is not recognisable", () => {
    const resolved = resolveConfiguratorDraftSteps({
      form: intent(),
      step: 3,
      maxStep: 4,
      stepId: "zzz" as ConfiguratorDraftEnvelope["stepId"],
      maxStepId: 7 as unknown as ConfiguratorDraftEnvelope["maxStepId"],
    });

    expect(resolved.step).toBe(3);
    expect(resolved.maxStep).toBe(4);
  });

  it("loads a draft saved before the ids existed exactly as before", () => {
    const form = intent();
    seedStoredDraft({ form, step: 3, maxStep: 5 });

    expect(createConfiguratorDraftPersistedState(KEY).load()).toEqual({
      form,
      step: 3,
      maxStep: 5,
    });
  });

  it("loads an id-addressed draft by its id", () => {
    seedStoredDraft({
      form: intent(),
      step: 2,
      maxStep: 2,
      stepId: "flavors",
      maxStepId: "flavors",
    });

    const loaded = createConfiguratorDraftPersistedState(KEY).load();

    expect(loaded?.step).toBe(3);
    expect(loaded?.maxStep).toBe(3);
  });

  it("keeps a draft whose id is unreadable instead of clearing it", () => {
    const form = intent();
    seedStoredDraft({ form, step: 3, maxStep: 3, stepId: "zzz", maxStepId: "zzz" });

    const result = createConfiguratorDraftPersistedState(KEY).loadResult();

    expect(result.status).toBe("loaded");
    expect(result.data).toEqual({ form, step: 3, maxStep: 3 });
    expect(localStorage.getItem(KEY)).not.toBeNull();
  });

  it("hands readers the plain shape, never the ids", () => {
    const store = createConfiguratorDraftPersistedState(KEY);
    store.save({ form: intent(), step: 4, maxStep: 4 });

    expect(Object.keys(store.load() ?? {})).toEqual(["form", "step", "maxStep"]);
  });
});

describe("configurator draft step ids — compatibility", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("stays readable by a reader that knows nothing about the ids (rollback)", () => {
    createConfiguratorDraftPersistedState(KEY).save({
      form: intent(),
      step: 5,
      maxStep: 6,
    });

    // The validator the previous bundle shipped: numbers and form only.
    const previousBundle = createPersistedState<ConfiguratorDraftEnvelope>({
      key: KEY,
      version: CONFIGURATOR_DRAFT_VERSION,
      ttlMs: CONFIGURATOR_DRAFT_TTL_MS,
      validate: (value) =>
        Number.isInteger(value.step) &&
        Number.isInteger(value.maxStep) &&
        Array.isArray(value.form?.promoCodes),
    });
    const loaded = previousBundle.loadResult();

    expect(loaded.status).toBe("loaded");
    expect(loaded.data?.step).toBe(5);
    expect(loaded.data?.maxStep).toBe(6);
    expect(loaded.data?.form.promoCodes).toEqual(["KEEPME"]);
  });

  it("keeps the draft version at 2 so no in-flight draft is cleared", () => {
    expect(CONFIGURATOR_DRAFT_VERSION).toBe(2);

    seedStoredDraft({ form: intent(), step: 3, maxStep: 3, stepId: "allergies" });
    localStorage.setItem(
      KEY,
      JSON.stringify({
        ...JSON.parse(localStorage.getItem(KEY) ?? "{}"),
        v: CONFIGURATOR_DRAFT_VERSION + 1,
      }),
    );

    expect(createConfiguratorDraftPersistedState(KEY).loadResult().status).toBe("invalid");
  });

  it("still expires an id-addressed draft on the unchanged TTL", () => {
    seedStoredDraft(
      { form: intent(), step: 3, maxStep: 3, stepId: "allergies", maxStepId: "allergies" },
      Date.now() - CONFIGURATOR_DRAFT_TTL_MS - 1,
    );

    expect(createConfiguratorDraftPersistedState(KEY).loadResult().status).toBe("expired");
  });
});

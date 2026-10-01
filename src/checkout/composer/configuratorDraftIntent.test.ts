/** @vitest-environment jsdom */
import { beforeEach, describe, expect, it, vi } from "vitest";

import {
  CONFIGURATOR_DRAFT_VERSION,
  createAccountConfiguratorDraftScope,
  createConfiguratorDraftPersistedState,
  getConfiguratorDraftStorageKey,
  LEGACY_FORM_KEY,
  migrateLegacyPublicDraft,
  PUBLIC_CONFIGURATOR_DRAFT_SCOPE,
  serializeConfiguratorIntent,
  type ConfiguratorDraftIntent,
} from "./configuratorDraftCodec";
import { withReadableOfferVersion } from "./configuratorDraftIntent";
import { defaultConfiguratorFormData } from "./configuratorFormStore";

// Storage keys always come from the codec: their literal values are the adopter's.
const KEY = getConfiguratorDraftStorageKey(PUBLIC_CONFIGURATOR_DRAFT_SCOPE);

function intent(offerVersion?: string | null): ConfiguratorDraftIntent {
  return serializeConfiguratorIntent(
    { ...defaultConfiguratorFormData, promoCodes: ["KEEPME"], offerVersion },
    PUBLIC_CONFIGURATOR_DRAFT_SCOPE,
  );
}

function seedStoredDraft(data: Record<string, unknown>): void {
  localStorage.setItem(KEY, JSON.stringify({ v: CONFIGURATOR_DRAFT_VERSION, savedAt: Date.now(), data }));
}

describe("configurator draft offer version", () => {
  beforeEach(() => {
    localStorage.clear();
  });

  it("serializes the offer version only when it is a string", () => {
    expect(intent("offer.v2").offerVersion).toBe("offer.v2");
    expect(intent(null)).not.toHaveProperty("offerVersion");
    expect(intent()).not.toHaveProperty("offerVersion");
    expect(serializeConfiguratorIntent(
      { ...defaultConfiguratorFormData, offerVersion: "offer.v2" },
      createAccountConfiguratorDraftScope("client-1", null),
    ).offerVersion).toBe("offer.v2");
  });

  it("keeps a readable offer version through a save and load round trip", () => {
    const store = createConfiguratorDraftPersistedState(KEY);

    expect(store.save({ form: intent("offer.v2"), step: 3, maxStep: 3 })).toBe("saved");

    expect(createConfiguratorDraftPersistedState(KEY).load()?.form.offerVersion).toBe("offer.v2");
  });

  it.each([
    ["a malformed token", "Offer V2"],
    ["a number", 2],
    ["null", null],
    ["an object", { version: "offer.v2" }],
  ])("drops %s on load and keeps the rest of the draft", (_case, unreadable) => {
    const form = intent();
    seedStoredDraft({ form: { ...form, offerVersion: unreadable }, step: 3, maxStep: 4 });

    const result = createConfiguratorDraftPersistedState(KEY).loadResult();

    expect(result.status).toBe("loaded");
    expect(result.data).toEqual({ form, step: 3, maxStep: 4 });
    expect(result.data?.form).not.toHaveProperty("offerVersion");
    expect(createConfiguratorDraftPersistedState(KEY).load()?.form).toEqual(form);
    expect(localStorage.getItem(KEY)).not.toBeNull();
  });

  it("returns the same draft object when there is nothing to drop", () => {
    const withoutVersion = { form: intent(), step: 1, maxStep: 1 };
    const withVersion = { form: intent("offer.v2"), step: 1, maxStep: 1 };

    expect(withReadableOfferVersion(withoutVersion)).toBe(withoutVersion);
    expect(withReadableOfferVersion(withVersion)).toBe(withVersion);
  });

  it("hydrates no draft as not answered yet, and a draft without the field as the default offer", async () => {
    vi.resetModules();
    const withoutDraft = await import("./configuratorFormStore");
    expect(withoutDraft.getConfiguratorFormData().offerVersion).toBeUndefined();

    seedStoredDraft({ form: intent(), step: 2, maxStep: 2 });
    vi.resetModules();
    const unversionedDraft = await import("./configuratorFormStore");
    expect(unversionedDraft.getConfiguratorFormData()).toMatchObject({ offerVersion: null, promoCodes: ["KEEPME"] });

    seedStoredDraft({ form: intent("offer.v2"), step: 2, maxStep: 2 });
    vi.resetModules();
    const versionedDraft = await import("./configuratorFormStore");
    expect(versionedDraft.getConfiguratorFormData().offerVersion).toBe("offer.v2");
  });

  it("keeps the draft version at 2", () => {
    expect(CONFIGURATOR_DRAFT_VERSION).toBe(2);
  });

  it("migrates a legacy draft without adding an offer version", () => {
    localStorage.setItem(LEGACY_FORM_KEY, JSON.stringify({
      v: 1,
      savedAt: Date.now(),
      data: { ...defaultConfiguratorFormData, promoCodes: ["LEGACY"] },
    }));

    const migrated = migrateLegacyPublicDraft(createConfiguratorDraftPersistedState(KEY));

    expect(migrated?.form.promoCodes).toEqual(["LEGACY"]);
    expect(migrated?.form).not.toHaveProperty("offerVersion");
  });
});

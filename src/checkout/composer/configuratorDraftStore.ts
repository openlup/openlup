import {
  type PersistedState,
  type PersistedWriteStatus,
} from "@/lib/persistentCommerceState";
import {
  createConfiguratorDraftPersistedState,
  getConfiguratorDraftStorageKey,
  migrateLegacyPublicDraft,
  PUBLIC_CONFIGURATOR_DRAFT_SCOPE,
  serializeConfiguratorIntent,
  type ConfiguratorDraftEnvelope,
  type ConfiguratorDraftScope,
} from "./configuratorDraftCodec";
import type { ConfiguratorFormData } from "./configuratorFormStore";

const SAVE_DELAY_MS = 120;
const MAX_SAVE_DELAY_MS = 750;

export {
  createAccountConfiguratorDraftScope,
  getConfiguratorDraftStorageKey,
  PUBLIC_CONFIGURATOR_DRAFT_SCOPE,
  serializeConfiguratorIntent,
} from "./configuratorDraftCodec";
export type {
  ConfiguratorDraftEnvelope,
  ConfiguratorDraftIntent,
  ConfiguratorDraftScope,
} from "./configuratorDraftCodec";

export type ConfiguratorDraftSaveStatus = PersistedWriteStatus | "conflict" | "idle";

interface DraftCacheEntry {
  store: PersistedState<ConfiguratorDraftEnvelope>;
  draft: ConfiguratorDraftEnvelope | null;
  loadedSnapshot: string | null;
  dirty: boolean;
  saveTimer: ReturnType<typeof setTimeout> | null;
  saveDeadline: number | null;
  lastStatus: ConfiguratorDraftSaveStatus;
  statusListeners: Set<(status: ConfiguratorDraftSaveStatus) => void>;
}

const cache = new Map<string, DraftCacheEntry>();

export function getConfiguratorDraft(
  scope: ConfiguratorDraftScope = PUBLIC_CONFIGURATOR_DRAFT_SCOPE,
): ConfiguratorDraftEnvelope | null {
  return getEntry(scope).draft;
}

export function updateConfiguratorDraftForm(
  data: ConfiguratorFormData,
  scope: ConfiguratorDraftScope = PUBLIC_CONFIGURATOR_DRAFT_SCOPE,
): void {
  const entry = getEntry(scope);
  const current = entry.draft;
  entry.draft = {
    form: serializeConfiguratorIntent(data, scope),
    step: current?.step ?? 1,
    maxStep: current?.maxStep ?? 1,
  };
  scheduleSave(entry);
}

export function updateConfiguratorDraftStep(
  step: number,
  maxStep: number,
  scope: ConfiguratorDraftScope = PUBLIC_CONFIGURATOR_DRAFT_SCOPE,
): void {
  const entry = getEntry(scope);
  if (!entry.draft) return;
  entry.draft = {
    ...entry.draft,
    step,
    maxStep: Math.max(step, maxStep),
  };
  scheduleSave(entry);
}

export function flushConfiguratorDraft(
  scope: ConfiguratorDraftScope = PUBLIC_CONFIGURATOR_DRAFT_SCOPE,
): ConfiguratorDraftSaveStatus {
  return flushEntry(getEntry(scope));
}

function flushEntry(entry: DraftCacheEntry): ConfiguratorDraftSaveStatus {
  cancelSave(entry);
  if (!entry.dirty || !entry.draft) return "idle";

  const onDisk = entry.store.loadResult();
  const onDiskSnapshot = onDisk.status === "loaded" ? JSON.stringify(onDisk.data) : null;
  const localSnapshot = JSON.stringify(entry.draft);
  if (
    onDisk.status !== "disabled" &&
    onDisk.status !== "unavailable" &&
    onDiskSnapshot !== entry.loadedSnapshot &&
    onDiskSnapshot !== localSnapshot
  ) {
    entry.lastStatus = "conflict";
    notifyDraftStatus(entry, "conflict");
    return "conflict";
  }

  const status = entry.store.save(entry.draft);
  entry.lastStatus = status;
  if (status === "saved" || status === "unchanged") {
    entry.dirty = false;
    entry.loadedSnapshot = localSnapshot;
  }
  notifyDraftStatus(entry, status);
  return status;
}

export function subscribeConfiguratorDraftStatus(
  scope: ConfiguratorDraftScope,
  listener: (status: ConfiguratorDraftSaveStatus) => void,
): () => void {
  if (typeof window === "undefined") return () => {};
  const listeners = getEntry(scope).statusListeners;
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function flushAllConfiguratorDrafts(): void {
  for (const entry of cache.values()) flushEntry(entry);
}

export function clearConfiguratorDraft(
  scope: ConfiguratorDraftScope = PUBLIC_CONFIGURATOR_DRAFT_SCOPE,
): void {
  const entry = getEntry(scope);
  cancelSave(entry);
  entry.dirty = false;
  entry.draft = null;
  entry.loadedSnapshot = null;
  entry.store.clear();
}

export function getConfiguratorDraftSaveStatus(
  scope: ConfiguratorDraftScope = PUBLIC_CONFIGURATOR_DRAFT_SCOPE,
): ConfiguratorDraftSaveStatus {
  return getEntry(scope).lastStatus;
}

export function installConfiguratorDraftLifecycle(): () => void {
  if (typeof window === "undefined" || typeof document === "undefined") return () => {};
  const handleVisibility = () => {
    if (document.visibilityState === "hidden") flushAllConfiguratorDrafts();
  };
  const handlePageHide = () => flushAllConfiguratorDrafts();
  document.addEventListener("visibilitychange", handleVisibility);
  window.addEventListener("pagehide", handlePageHide);
  return () => {
    document.removeEventListener("visibilitychange", handleVisibility);
    window.removeEventListener("pagehide", handlePageHide);
  };
}

/** Test-only reset for module-owned timers and caches. */
export function resetConfiguratorDraftStoreForTests(): void {
  for (const entry of cache.values()) cancelSave(entry);
  cache.clear();
}

function getEntry(scope: ConfiguratorDraftScope): DraftCacheEntry {
  const key = getConfiguratorDraftStorageKey(scope);
  const existing = cache.get(key);
  if (existing) return existing;

  const store = createConfiguratorDraftPersistedState(key);
  const loaded = store.loadResult();
  const draft = loaded.data ?? (scope.kind === "public" ? migrateLegacyPublicDraft(store) : null);
  const entry: DraftCacheEntry = {
    store,
    draft,
    loadedSnapshot: draft ? JSON.stringify(draft) : null,
    dirty: false,
    saveTimer: null,
    saveDeadline: null,
    lastStatus: "idle",
    statusListeners: new Set(),
  };
  cache.set(key, entry);
  return entry;
}

function scheduleSave(entry: DraftCacheEntry): void {
  entry.dirty = true;
  const now = Date.now();
  entry.saveDeadline ??= now + MAX_SAVE_DELAY_MS;
  const delay = Math.min(SAVE_DELAY_MS, Math.max(0, entry.saveDeadline - now));
  if (entry.saveTimer) clearTimeout(entry.saveTimer);
  entry.saveTimer = setTimeout(() => flushEntry(entry), delay);
}

function cancelSave(entry: DraftCacheEntry): void {
  if (entry.saveTimer) clearTimeout(entry.saveTimer);
  entry.saveTimer = null;
  entry.saveDeadline = null;
}

function notifyDraftStatus(entry: DraftCacheEntry, status: ConfiguratorDraftSaveStatus): void {
  for (const listener of entry.statusListeners) {
    try {
      listener(status);
    } catch {
      // A UI subscriber must not turn a completed storage operation into a failure.
    }
  }
}

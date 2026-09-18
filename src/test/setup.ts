import { relative } from "node:path";

import { afterEach, beforeEach, expect, inject, vi } from "vitest";

import { clearAllRequestCaches } from "@/checkout/machine/commerceRequestCache";
import { deriveTestTimeoutMs, flatTestTimeoutMs } from "../../scripts/ci-vitest-duration-keys.ts";
// `inject()` keys are typed in ./vitestProvidedContext.d.ts, outside this file's import closure.

// Verify W1: logic tests run in the node environment. jest-dom, React Testing
// Library, window mocks and the translation preload only load when a DOM
// exists, so node workers skip their import cost entirely. The condition is
// evaluated per file, so a .test.ts opting into jsdom with a
// `@vitest-environment` pragma still gets all of it.
const HAS_DOM = typeof window !== "undefined";

// RR-L4: timeouts are budgets. This file is executed once per test file, before
// that file is collected, and `expect.getState().testPath` names the file it is
// being executed for -- so this is the one place a PER-FILE ceiling can be set.
// It is `max(flat, 1.5 x the file's pinned duration)`: an unpinned file keeps the
// flat ceiling exactly, and a pinned one is allowed a single test as expensive as
// the whole file was measured to be. A hung test still exceeds any finite budget,
// so `retry: 0` and every assertion are untouched by this.
//
// The weights and the repository root arrive through `provide` from
// vitest.config.ts. This file must NOT read them itself: under the coverage lane
// its own `import.meta.url` is not a file: URL, so a filesystem read here throws
// for every test file in the run.
const testFilePath = expect.getState().testPath;
if (testFilePath) {
  const repositoryRelative = relative(inject("repositoryRoot"), testFilePath).split("\\").join("/");
  const budgetMs = deriveTestTimeoutMs(
    inject("durationManifest"),
    repositoryRelative,
    flatTestTimeoutMs(inject("coverageRun")),
  );
  vi.setConfig({ testTimeout: budgetMs, hookTimeout: budgetMs });
}

vi.stubEnv("VITE_SUPABASE_URL", "https://example.supabase.co");
vi.stubEnv("VITE_SUPABASE_ANON_KEY", "test-anon-key");
// A doctor-generated .env.local carries a real local publishable key, which
// would shadow the stubbed legacy alias in both the browser client
// (resolveSupabasePublishableKey) and the server env readers (`??` chains in
// server/_lib/admin-domain/auth.ts). Remove it so local vitest runs match CI,
// which has no .env.local.
vi.stubEnv("VITE_SUPABASE_PUBLISHABLE_KEY", undefined);

function createStorageMock(): Storage {
  let store = new Map<string, string>();
  return {
    get length() {
      return store.size;
    },
    clear: () => {
      store = new Map();
    },
    getItem: (key: string) => store.get(key) ?? null,
    key: (index: number) => Array.from(store.keys())[index] ?? null,
    removeItem: (key: string) => {
      store.delete(key);
    },
    setItem: (key: string, value: string) => {
      store.set(key, String(value));
    },
  };
}

// Installed in both environments so storage-dependent logic behaves the same
// in node and jsdom tests.
Object.defineProperty(globalThis, "localStorage", {
  configurable: true,
  value: createStorageMock(),
});
Object.defineProperty(globalThis, "sessionStorage", {
  configurable: true,
  value: createStorageMock(),
});

let cleanupDom: (() => void) | undefined;

if (HAS_DOM) {
  await import("@testing-library/jest-dom/vitest");
  const { cleanup, configure } = await import("@testing-library/react");
  // Provided by vitest.config.ts from the main process. This file runs inside a forked
  // worker whose argv never carries `--coverage`, so the previous argv check here was
  // never true and silently left the 1s default in place, making every findBy*/waitFor a
  // load-sensitive flake in the coverage lane.
  if (inject("coverageRun")) {
    configure({ asyncUtilTimeout: 10_000 });
  }
  cleanupDom = cleanup;

  Object.defineProperty(window, "localStorage", {
    configurable: true,
    value: globalThis.localStorage,
  });
  Object.defineProperty(window, "sessionStorage", {
    configurable: true,
    value: globalThis.sessionStorage,
  });

  Object.defineProperty(window, "matchMedia", {
    writable: true,
    value: (query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: () => {},
      removeListener: () => {},
      addEventListener: () => {},
      removeEventListener: () => {},
      dispatchEvent: () => {},
    }),
  });

  class ResizeObserverMock {
    observe() {}
    unobserve() {}
    disconnect() {}
  }

  Object.defineProperty(window, "scrollTo", {
    writable: true,
    value: vi.fn(),
  });

  Object.defineProperty(window, "ResizeObserver", {
    writable: true,
    value: ResizeObserverMock,
  });
}

beforeEach(() => {
  vi.restoreAllMocks();
  localStorage.clear();
  sessionStorage.clear();
  // Session-scoped commerce caches are module singletons — reset between tests so
  // a quote/recommendation cached in one case doesn't satisfy another's fetch.
  clearAllRequestCaches();
});

afterEach(() => {
  cleanupDom?.();
});

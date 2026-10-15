import { afterEach, describe, expect, it, vi } from "vitest";
import {
  createBundleComposer,
  type PlatformBundleBinders,
  type PlatformBundlePorts,
} from "../../src/composition/composeBundle.js";
import { createDataBindings } from "../../src/data/binding.js";
import { bindBlobPort } from "../../src/blob/binding.js";

const dataBinder = () => createDataBindings({ createSupabaseClient: vi.fn(() => ({})) }).bindDataPort;

afterEach(() => vi.unstubAllGlobals());

const matrix = [
  ["vercel-supabase", { http: "vercel", scheduler: "vercel-cron", blob: "vercel-blob", data: "supabase", migrations: "supabase", analytics: "vercel", transactional: "application" }],
  ["node-supabase", { http: "node", scheduler: "node-cron", blob: "supabase", data: "supabase", migrations: "supabase", analytics: "gtm", transactional: "node" }],
  ["node-postgres", { http: "node", scheduler: "node-cron", blob: "filesystem", data: "postgres", migrations: "postgres", analytics: "noop", transactional: "node" }],
] as const;

describe("bundle composition", () => {
  it.each([{}, { PLATFORM_BUNDLE: "unknown-bundle" }])("defaults an absent or unknown bundle selector", (env) => {
    const bundle = createBundleComposer()(env);
    expect(bundle.id).toBe("vercel-supabase");
    expect(bundle.descriptor.id).toBe("vercel-supabase");
    expect(bundle.descriptor.capabilities).toEqual(matrix[0][1]);
  });

  it.each(matrix)("passes the declared capabilities and original environment to every %s binder", (id, capabilities) => {
    const env = { PLATFORM_BUNDLE: id, APP_BASE_URL: "https://example.test" };
    const order: string[] = [];
    const slots = ["http", "blob", "data", "migrations", "analytics", "transactional", "scheduler"] as const;
    const outputs = Object.fromEntries(slots.map((slot) => [slot, { slot }])) as unknown as PlatformBundlePorts;
    const calls: Record<string, ReturnType<typeof vi.fn>> = {};
    for (const slot of slots) calls[slot] = vi.fn(() => { order.push(slot); return outputs[slot]; });
    const compose = createBundleComposer(calls as PlatformBundleBinders);
    const bundle = compose(env);
    expect(bundle.id).toBe(id);
    expect(bundle.descriptor.id).toBe(id);
    expect(bundle.descriptor.capabilities).toEqual(capabilities);
    expect(order).toEqual(slots);
    for (const slot of slots) {
      expect(bundle.ports[slot]).toBe(outputs[slot]);
      if (slot === "transactional") {
        expect(calls[slot]).toHaveBeenCalledExactlyOnceWith(capabilities[slot], capabilities.data, env);
      } else {
        expect(calls[slot]).toHaveBeenCalledExactlyOnceWith(capabilities[slot], env);
      }
    }
    expect(Object.keys(bundle.ports).sort()).toEqual([...slots].sort());
  });

  it.each(matrix)("leaves caller-owned slots unbound for %s", (id) => {
    const { ports } = createBundleComposer()({ PLATFORM_BUNDLE: id });
    for (const slot of ["http", "scheduler", "migrations", "analytics", "transactional"] as const) {
      expect(ports[slot]).toBeNull();
    }
  });

  it("preserves a binder's refusal, including overrides of default binders", () => {
    const decline = vi.fn(() => null);
    const { ports } = createBundleComposer({
      http: decline, scheduler: decline, blob: decline, data: decline,
      migrations: decline, analytics: decline, transactional: decline,
    })({ PLATFORM_BUNDLE: "node-postgres" });
    expect(Object.values(ports)).toEqual(Array(7).fill(null));
    expect(decline).toHaveBeenCalledTimes(7);
  });

  it.each(matrix)("binds a lazy data gateway without credentials for %s", (id) => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const { data } = createBundleComposer({ data: dataBinder() })({ PLATFORM_BUNDLE: id }).ports;
    expect(data).not.toBeNull();
    expect(data?.asActor).toBeTypeOf("function");
    expect(data?.asService).toBeTypeOf("function");
    expect(fetch).not.toHaveBeenCalled();
  });

  it("adds no transport or extra credential reads for an unbound transactional slot", () => {
    const fetch = vi.fn();
    vi.stubGlobal("fetch", fetch);
    const reads: string[] = [];
    const env = new Proxy<Record<string, string | undefined>>({}, {
      get(_target, key) {
        if (["SUPABASE_URL", "VITE_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"].includes(String(key))) reads.push(String(key));
        return undefined;
      },
    });
    expect(createBundleComposer({ data: dataBinder() })(env).ports.transactional).toBeNull();
    expect(reads).toEqual(["SUPABASE_URL", "VITE_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY"]);
    expect(fetch).not.toHaveBeenCalled();
  });

  it("binds blob storage only where its client is available and leaves runtime-client storage unbound", () => {
    expect(createBundleComposer()({}).ports.blob).toBeNull();
    const vercelBlob = { put: vi.fn(), head: vi.fn(), del: vi.fn(), list: vi.fn() };
    const blob = (capability: string, env: Record<string, string | undefined>) => bindBlobPort(capability, env, { vercelBlob });
    expect(createBundleComposer({ blob })({}).ports.blob).not.toBeNull();
    expect(createBundleComposer({ blob })({ PLATFORM_BUNDLE: "node-supabase" }).ports.blob).toBeNull();
  });

  it.each([
    { PLATFORM_BUNDLE: "node-supabase", SUPABASE_URL: "https://data.example.test" },
    { PLATFORM_BUNDLE: "node-supabase", VITE_SUPABASE_URL: "https://data.example.test" },
    { PLATFORM_BUNDLE: "node-postgres", PLATFORM_BLOB: "supabase", SUPABASE_URL: "https://data.example.test" },
  ])("binds working Supabase Storage through the default composer with %j", async (selection) => {
    const upload = vi.fn(async () => ({ data: {}, error: null }));
    const from = vi.fn(() => ({
      upload, remove: vi.fn(), list: vi.fn(),
      getPublicUrl: (path: string) => ({ data: { publicUrl: `https://data.example.test/${path}` } }),
    }));
    const createSupabaseClient = vi.fn(() => ({ storage: { from } }));
    const blob = createBundleComposer({ createSupabaseClient })({
      ...selection, SUPABASE_SERVICE_ROLE_KEY: "service-key", BLOB_SUPABASE_BUCKET: "objects",
    }).ports.blob;
    expect(blob).not.toBeNull();
    const bytes = Buffer.from("a");
    await expect(blob!.upload("a.txt", bytes)).resolves.toEqual({
      url: "https://data.example.test/a.txt", pathname: "a.txt",
    });
    expect(blob!.urlFor("a.txt")).toBe("https://data.example.test/a.txt");
    expect(createSupabaseClient).toHaveBeenCalledExactlyOnceWith("https://data.example.test", "service-key", {
      auth: { persistSession: false, autoRefreshToken: false },
    });
    expect(from).toHaveBeenCalledWith("objects");
    expect(upload).toHaveBeenCalledExactlyOnceWith("a.txt", bytes, {
      contentType: "application/octet-stream", upsert: true,
    });
  });

  it("leaves default Supabase Storage unbound without the injected SDK", () => {
    expect(createBundleComposer()({
      PLATFORM_BUNDLE: "node-supabase", SUPABASE_URL: "https://data.example.test",
      SUPABASE_SERVICE_ROLE_KEY: "service-key", BLOB_SUPABASE_BUCKET: "objects",
    }).ports.blob).toBeNull();
  });

  it.each([
    { BLOB_SUPABASE_BUCKET: undefined }, { BLOB_SUPABASE_BUCKET: "" },
    { SUPABASE_URL: undefined }, { SUPABASE_URL: "" },
    { SUPABASE_SERVICE_ROLE_KEY: undefined }, { SUPABASE_SERVICE_ROLE_KEY: "" },
  ])("declines default Supabase Storage without required settings: %j", (missing) => {
    const createSupabaseClient = vi.fn();
    expect(createBundleComposer({ createSupabaseClient })({
      PLATFORM_BUNDLE: "node-supabase", SUPABASE_URL: "https://data.example.test",
      SUPABASE_SERVICE_ROLE_KEY: "service-key", BLOB_SUPABASE_BUCKET: "objects", ...missing,
    }).ports.blob).toBeNull();
    expect(createSupabaseClient).not.toHaveBeenCalled();
  });

  it("keeps an injected Supabase SDK unused when a custom blob binder overrides the default", () => {
    const createSupabaseClient = vi.fn();
    const blob = vi.fn(() => null);
    const env = {
      PLATFORM_BUNDLE: "node-supabase", SUPABASE_URL: "https://data.example.test",
      SUPABASE_SERVICE_ROLE_KEY: "service-key", BLOB_SUPABASE_BUCKET: "objects",
    };
    expect(createBundleComposer({ createSupabaseClient, blob })(env).ports.blob).toBeNull();
    expect(blob).toHaveBeenCalledExactlyOnceWith("supabase", env);
    expect(createSupabaseClient).not.toHaveBeenCalled();
  });

  it.each([
    {}, { BLOB_FS_ROOT: "/synthetic/storage" }, { BLOB_FS_BASE_URL: "https://assets.example.test" },
    { BLOB_FS_ROOT: "", BLOB_FS_BASE_URL: "https://assets.example.test" },
    { BLOB_FS_ROOT: "/synthetic/storage", BLOB_FS_BASE_URL: "" },
  ])("requires both filesystem settings before binding blob storage", (settings) => {
    expect(createBundleComposer()({ PLATFORM_BUNDLE: "node-postgres", ...settings }).ports.blob).toBeNull();
  });

  it("constructs filesystem storage when both settings are provided", () => {
    const blob = createBundleComposer()({
      PLATFORM_BUNDLE: "node-postgres", BLOB_FS_ROOT: "/synthetic/storage",
      BLOB_FS_BASE_URL: "https://assets.example.test",
    }).ports.blob;
    expect(blob).not.toBeNull();
    expect(blob?.urlFor("objects/a.png")).toBe("https://assets.example.test/objects/a.png");
  });
});

describe("selected blob capability", () => {
  it("binds the blob capability PLATFORM_BLOB selects", () => {
    const blob = vi.fn(() => null);
    createBundleComposer({ blob })({ PLATFORM_BUNDLE: "node-postgres", PLATFORM_BLOB: "s3" });
    createBundleComposer({ blob })({ PLATFORM_BUNDLE: "node-postgres", PLATFORM_BLOB: "tape" });
    createBundleComposer({ blob })({ PLATFORM_BUNDLE: "node-postgres" });
    expect(blob.mock.calls.map(([capability]) => capability)).toEqual(["s3", "filesystem", "filesystem"]);
    const s3 = createBundleComposer()({
      PLATFORM_BUNDLE: "node-postgres", PLATFORM_BLOB: "s3", BLOB_S3_BUCKET: "objects", BLOB_S3_BASE_URL: "https://objects.example.test",
    }).ports.blob;
    expect(s3?.urlFor("a.txt")).toBe("https://objects.example.test/a.txt");
  });
});

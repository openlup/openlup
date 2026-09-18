import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../../../_lib/types/vercel.js";

const { mockCreateClient, mockClientState } = vi.hoisted(() => ({
  mockCreateClient: vi.fn(() => mockClientState.client),
  mockClientState: {
    client: null as unknown,
    packRows: [] as PackRow[],
    packError: null as { message?: string } | null,
  },
}));

vi.mock("@supabase/supabase-js", () => ({
  createClient: mockCreateClient,
}));

const ENV_KEYS = [
  "SUPABASE_URL",
  "VITE_SUPABASE_URL",
  "SUPABASE_ANON_KEY",
  "VITE_SUPABASE_ANON_KEY",
  "VITE_SUPABASE_PUBLISHABLE_KEY",
  "SUPABASE_SERVICE_ROLE_KEY",
] as const;

type EnvKey = (typeof ENV_KEYS)[number];

describe("admin catalog sku-eans BFF route", () => {
  const originalEnv = new Map<EnvKey, string | undefined>();

  beforeEach(() => {
    vi.resetModules();
    vi.spyOn(console, "log").mockImplementation(() => undefined);
    vi.spyOn(console, "error").mockImplementation(() => undefined);
    mockCreateClient.mockClear();
    mockClientState.packRows = [packRow()];
    mockClientState.packError = null;
    mockClientState.client = createSupabaseClient();
    for (const key of ENV_KEYS) {
      originalEnv.set(key, process.env[key]);
      delete process.env[key];
    }
  });

  afterEach(() => {
    vi.restoreAllMocks();
    for (const key of ENV_KEYS) {
      const value = originalEnv.get(key);
      if (value === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = value;
      }
    }
    originalEnv.clear();
  });

  it("serves catalog packs through an admin actor gateway", async () => {
    process.env.VITE_SUPABASE_URL = "https://example.supabase.co";
    process.env.VITE_SUPABASE_ANON_KEY = "anon-key";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    const { default: handler } = await import("./sku-eans.js");
    const res = createResponse();

    await handler(request("GET", "admin-token"), res);

    expect(mockCreateClient).toHaveBeenCalledWith(
      "https://example.supabase.co",
      "anon-key",
      {
        auth: { persistSession: false, autoRefreshToken: false },
        global: { headers: { Authorization: "Bearer admin-token" } },
      },
    );
    expect(res.status).toHaveBeenCalledWith(200);
    expect(res.json).toHaveBeenCalledWith({
      ok: true,
      data: {
        skus: [
          {
            sku: "OPENLUP-DOG-LAMB-CAN-400G",
            packs: [
              {
                ean: "5908121193005",
                kind: "unit",
                quantity: 1,
                isPrimary: true,
                source: "local",
              },
            ],
          },
        ],
        totalPacks: 1,
      },
    });
  });

  it("fails closed before creating a client when anon env is missing", async () => {
    process.env.VITE_SUPABASE_URL = "https://example.supabase.co";
    process.env.SUPABASE_SERVICE_ROLE_KEY = "service-role-key";
    const { default: handler } = await import("./sku-eans.js");
    const res = createResponse();

    await handler(request("GET", "admin-token"), res);

    expect(mockCreateClient).not.toHaveBeenCalled();
    expect(res.status).toHaveBeenCalledWith(500);
  });
});

interface PackRow {
  sku: string;
  ean: string;
  kind: string;
  quantity: number;
  is_primary: boolean;
  source: string;
}

function packRow(): PackRow {
  return {
    sku: "OPENLUP-DOG-LAMB-CAN-400G",
    ean: "5908121193005",
    kind: "unit",
    quantity: 1,
    is_primary: true,
    source: "local",
  };
}

function createSupabaseClient() {
  const adminUsersBuilder = {
    select: vi.fn(() => adminUsersBuilder),
    eq: vi.fn(() => adminUsersBuilder),
    maybeSingle: vi.fn(async () => ({
      data: { id: "admin-user-1", role: "admin", is_machine_actor: false },
      error: null,
    })),
  };
  const packsBuilder = {
    select: vi.fn(() => packsBuilder),
    order: vi.fn(() => packsBuilder),
    then: (
      resolve: (value: { data: PackRow[] | null; error: { message?: string } | null }) => unknown,
      reject?: (reason: unknown) => unknown,
    ) =>
      Promise.resolve({
        data: mockClientState.packRows,
        error: mockClientState.packError,
      }).then(resolve, reject),
  };

  return {
    auth: {
      getUser: vi.fn(async (token: string) => ({
        data: { user: token === "admin-token" ? { id: "admin-user-1" } : null },
        error: null,
      })),
    },
    from: vi.fn((table: string) => {
      if (table === "admin_users") return adminUsersBuilder;
      if (table === "catalog_sku_eans") return packsBuilder;
      throw new Error(`unexpected table ${table}`);
    }),
  };
}

function request(method: string, token: string): VercelRequest {
  return {
    method,
    body: {},
    query: {},
    headers: { authorization: `Bearer ${token}` },
  } as unknown as VercelRequest;
}

function createResponse(): VercelResponse {
  const res = {
    setHeader: vi.fn(),
    status: vi.fn(),
    json: vi.fn(),
  } as unknown as VercelResponse;
  vi.mocked(res.status).mockReturnValue(res);
  vi.mocked(res.json).mockReturnValue(res);
  return res;
}

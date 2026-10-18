import { describe, expect, it, vi } from "vitest";
import { createSupabaseAdminAuthFromEnv, createSupabaseAdminAuth } from "./adminAuthVerifier.js";

const sdkFactory = vi.hoisted(() => vi.fn());
vi.mock("@supabase/supabase-js", () => ({ createClient: sdkFactory }));

type AdminRow = { id: string; role: string; is_machine_actor: boolean | null };

function adminClient(opts: {
  user: { id: string } | null;
  userError?: unknown;
  row: AdminRow | null;
  rowError?: unknown;
}) {
  const query = {
    eq: vi.fn(),
    maybeSingle: vi.fn(async () => ({ data: opts.row, error: opts.rowError ?? null })),
  };
  query.eq.mockImplementation(() => query);
  return {
    auth: {
      getUser: vi.fn(async () => ({
        data: { user: opts.user },
        error: opts.userError ?? null,
      })),
    },
    from: vi.fn(() => ({
      select: vi.fn(() => query),
    })),
  };
}

describe("createSupabaseAdminAuth", () => {
  it("UUID-keep: principalId is the auth user id and machine-actor is DB-derived", async () => {
    const port = createSupabaseAdminAuth(
      adminClient({
        user: { id: "auth-uuid-7" },
        row: { id: "auth-uuid-7", role: "admin", is_machine_actor: false },
      }),
    );
    expect(await port.authorize("tok")).toEqual({
      ok: true,
      principalId: "auth-uuid-7",
      role: "admin",
      isMachineActor: false,
    });
  });

  it("fails closed to machine actor when is_machine_actor is not explicitly false", async () => {
    const port = createSupabaseAdminAuth(
      adminClient({
        user: { id: "u1" },
        row: { id: "u1", role: "distributor", is_machine_actor: null },
      }),
    );
    const result = await port.authorize("tok");
    expect(result).toMatchObject({ ok: true, role: "distributor", isMachineActor: true });
  });

  it("returns UNAUTHORIZED without a token", async () => {
    const port = createSupabaseAdminAuth(adminClient({ user: null, row: null }));
    expect(await port.authorize(null)).toEqual({
      ok: false,
      code: "UNAUTHORIZED",
      message: "Admin session required",
    });
  });

  it("returns FORBIDDEN when the principal is not an admin row", async () => {
    const port = createSupabaseAdminAuth(adminClient({ user: { id: "u2" }, row: null }));
    expect(await port.authorize("tok")).toEqual({
      ok: false,
      code: "FORBIDDEN",
      message: "Admin role required",
    });
  });

  it("enforces allowedRoles (distributor token denied on admin-only route)", async () => {
    const port = createSupabaseAdminAuth(
      adminClient({
        user: { id: "u3" },
        row: { id: "u3", role: "distributor", is_machine_actor: false },
      }),
    );
    expect(await port.authorize("tok", { allowedRoles: ["admin"] })).toEqual({
      ok: false,
      code: "FORBIDDEN",
      message: "Admin role required",
    });
  });
});


it("reference authorization uses only the actor client and requires no service key or activation", async () => {
  sdkFactory.mockReset();
  const id = "d4300000-0000-4000-8000-000000000001";
  const actor = adminClient({ user: { id }, row: { id, role: "admin", is_machine_actor: false } });
  sdkFactory.mockReturnValueOnce(actor as never);
  const port = createSupabaseAdminAuthFromEnv({ url: "https://example.invalid", anonKey: "synthetic-anon" }, "synthetic-token");
  expect(await port.authorize("synthetic-token")).toMatchObject({ ok: true, principalId: id });
  expect(sdkFactory).toHaveBeenCalledExactlyOnceWith("https://example.invalid", "synthetic-anon", {
    auth: { persistSession: false, autoRefreshToken: false }, global: { headers: { Authorization: "Bearer synthetic-token" } },
  });
});

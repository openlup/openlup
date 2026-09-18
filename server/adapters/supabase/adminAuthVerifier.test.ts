import { describe, expect, it, vi } from "vitest";
import type { SupabaseClient } from "@supabase/supabase-js";
import type { Database } from "../../../src/integrations/supabase/types.js";
import { createSupabaseAdminAuth } from "./adminAuthVerifier.js";

type AdminRow = { id: string; role: string; is_machine_actor: boolean | null };

function adminClient(opts: {
  user: { id: string } | null;
  userError?: unknown;
  row: AdminRow | null;
  rowError?: unknown;
}): SupabaseClient<Database> {
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
  } as unknown as SupabaseClient<Database>;
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

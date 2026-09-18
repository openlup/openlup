import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import handler from "./provider-sync.js";

describe("accounting provider-sync BFF boundary", () => {
  it("runs accounting control through the domain gateway", () => {
    const source = readFileSync(
      join(process.cwd(), "server/bff/admin/accounting/provider-sync.ts"),
      "utf8",
    );

    expect(source).toContain("createSupabaseAdminAccountingGateway");
    expect(source).not.toContain("createServiceRoleClient");
    expect(source).not.toMatch(/\.(?:from|rpc|storage)\b/);
    expect(handler).toEqual(expect.any(Function));
  });

  it("fails closed through the observed route without runtime configuration", async () => {
    const res = { setHeader: vi.fn(), status: vi.fn(), json: vi.fn() } as unknown as Parameters<typeof handler>[1];
    vi.mocked(res.status).mockReturnValue(res);

    await handler({ method: "POST", query: {}, headers: {} } as unknown as Parameters<typeof handler>[0], res);

    expect(res.status).toHaveBeenCalledWith(503);
  });
});

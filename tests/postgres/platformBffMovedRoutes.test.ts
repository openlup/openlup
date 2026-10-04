import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { VercelRequest, VercelResponse } from "../../server/_lib/types/vercel.js";

type Route = (req: VercelRequest, res: VercelResponse) => Promise<void>;

let originalEnv: NodeJS.ProcessEnv;

function mockRes() {
  const res = {
    statusCode: 0,
    body: undefined as unknown,
    setHeader: vi.fn(),
    status(code: number) {
      res.statusCode = code;
      return res;
    },
    json(payload: unknown) {
      res.body = payload;
      return res;
    },
    end: vi.fn(),
  };
  return res as unknown as VercelResponse & {
    statusCode: number;
    body: { ok: boolean; error?: { code: string; message: string } };
  };
}

beforeEach(() => {
  originalEnv = process.env;
  process.env = {};
});

afterEach(() => {
  process.env = originalEnv;
  vi.restoreAllMocks();
});

describe("moved Platform BFF adapters", () => {
  it.each([
    ["admin role update", "../../server/bff/admin/platform/admin-users/role.js", "POST"],
    ["admin me", "../../server/bff/admin/platform/me.js", "GET"],
    ["pipeline", "../../server/bff/admin/platform/pipeline.js", "GET"],
    ["settings", "../../server/bff/admin/platform/settings.js", "GET"],
    ["settings update", "../../server/bff/admin/platform/settings/update.js", "POST"],
  ] as const)("public default refuses %s before reading request data", async (_name, modulePath, method) => {
    const res = mockRes();
    const route = (await import(modulePath)).default as Route;

    const touched = vi.fn(() => { throw new Error("request body read"); });
    const req = { method, headers: {} };
    Object.defineProperty(req, "body", { get: touched });
    await route(req as unknown as VercelRequest, res);
    expect(touched).not.toHaveBeenCalled();

    expect(res.statusCode).toBe(503);
    expect(res.body.ok).toBe(false);
    expect(res.body.error?.code).toBe("UPSTREAM_UNAVAILABLE");
    expect(res.body.error).toMatchObject({ details: { reason: "adopter_policy_required" } });
  });
});

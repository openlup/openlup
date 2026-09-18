import { describe, expect, it, vi } from "vitest";
import type { VercelRequest, VercelResponse } from "../../../_lib/types/vercel.js";
import { createDhlRepairCourierPickupRoute } from "./dhl-repair-courier-pickup.js";

describe("admin DHL courier pickup repair BFF route adapters", () => {
  it.each([
    { mode: "commit", sendEmails: false },
    { mode: "dry_run", sendEmails: true },
    { mode: "dry_run" },
  ])("rejects retired mutation %# before auth, port, or domain composition", async (body) => {
    const createAuthContext = vi.fn();
    const createPort = vi.fn();
    const authorizeAdmin = vi.fn();
    const createDomainHandler = vi.fn();
    const target = response();
    await createDhlRepairCourierPickupRoute({
      createAuthContext, createPort, authorizeAdmin, createDomainHandler,
    } as never)({ method: "POST", body } as VercelRequest, target.res);
    expect(target.status).toBe(404);
    expect(target.body).toMatchObject({ error: { details: { reason: "direct_dhl_repair_mutation_retired" } } });
    expect(createAuthContext).not.toHaveBeenCalled();
    expect(createPort).not.toHaveBeenCalled();
    expect(authorizeAdmin).not.toHaveBeenCalled();
    expect(createDomainHandler).not.toHaveBeenCalled();
  });
});

function response() {
  const target = { status: 200, body: undefined as unknown };
  const res = {
    setHeader: vi.fn(), end: vi.fn(),
    status(code: number) { target.status = code; return res; },
    json(body: unknown) { target.body = body; return res; },
  } as unknown as VercelResponse;
  return { ...target, get status() { return target.status; }, get body() { return target.body; }, res };
}

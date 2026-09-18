import { describe, expect, it, vi } from "vitest";

import {
  createOperatorTokenAdminAuth,
  resolvePlatformOperatorAuthConfig,
} from "./operatorTokenAdminAuth.js";

const TOKEN = "t".repeat(32);
const OPERATOR_ID = "9f576216-011a-4f67-8404-3f28f7f624d5";

describe("operator-token admin auth", () => {
  it("refuses missing and malformed direct-bundle configuration", () => {
    expect(resolvePlatformOperatorAuthConfig({})).toEqual({ error: "platform_operator_token_required" });
    expect(resolvePlatformOperatorAuthConfig({ PLATFORM_OPERATOR_TOKEN: "short" }))
      .toEqual({ error: "platform_operator_token_invalid" });
    expect(resolvePlatformOperatorAuthConfig({ PLATFORM_OPERATOR_TOKEN: TOKEN }))
      .toEqual({ error: "platform_operator_id_required" });
    expect(resolvePlatformOperatorAuthConfig({
      PLATFORM_OPERATOR_TOKEN: TOKEN,
      PLATFORM_OPERATOR_ID: "operator-1",
    })).toEqual({ error: "platform_operator_id_invalid" });
    expect(resolvePlatformOperatorAuthConfig({
      PLATFORM_OPERATOR_TOKEN: "x".repeat(513),
      PLATFORM_OPERATOR_ID: OPERATOR_ID,
    })).toEqual({ error: "platform_operator_token_invalid" });
  });

  it("does not consult the allowlist for a missing, wrong, or oversized bearer", async () => {
    const checker = vi.fn(async () => true);
    const auth = createOperatorTokenAdminAuth({ operatorToken: TOKEN, operatorId: OPERATOR_ID }, checker);
    await expect(auth.authorize(null)).resolves.toMatchObject({ ok: false, code: "UNAUTHORIZED" });
    await expect(auth.authorize("wrong")).resolves.toMatchObject({ ok: false, code: "UNAUTHORIZED" });
    await expect(auth.authorize("x".repeat(513))).resolves.toMatchObject({ ok: false, code: "UNAUTHORIZED" });
    expect(checker).not.toHaveBeenCalled();
  });

  it("requires the durable allowlist and returns a machine admin identity", async () => {
    const denied = vi.fn(async () => false);
    const deniedAuth = createOperatorTokenAdminAuth({ operatorToken: TOKEN, operatorId: OPERATOR_ID }, denied);
    await expect(deniedAuth.authorize(TOKEN)).resolves.toEqual({
      ok: false,
      code: "FORBIDDEN",
      message: "Admin role required",
    });
    expect(denied).toHaveBeenCalledWith(OPERATOR_ID);

    const allowed = vi.fn(async () => true);
    const auth = createOperatorTokenAdminAuth({ operatorToken: TOKEN, operatorId: OPERATOR_ID }, allowed);
    await expect(auth.authorize(TOKEN)).resolves.toEqual({
      ok: true,
      principalId: OPERATOR_ID,
      role: "admin",
      isMachineActor: true,
    });
  });

  it("refuses a machine admin where the route excludes the admin role without consulting the DB", async () => {
    const checker = vi.fn(async () => true);
    const auth = createOperatorTokenAdminAuth({ operatorToken: TOKEN, operatorId: OPERATOR_ID }, checker);
    await expect(auth.authorize(TOKEN, { allowedRoles: ["distributor"] })).resolves.toMatchObject({
      ok: false,
      code: "FORBIDDEN",
    });
    expect(checker).not.toHaveBeenCalled();
  });
});

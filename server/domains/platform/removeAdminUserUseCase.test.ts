import { expect, it, vi } from "vitest";

import {
  runRemoveAdminUserUseCase,
  type RemoveAdminUserGateway,
} from "./removeAdminUserUseCase.js";

it("rejects a missing admin session before revoke effects", async () => {
  const gateway: RemoveAdminUserGateway = {
    getUser: vi.fn(), findAdminUser: vi.fn(),
    revokeAdminUser: vi.fn(),
  };

  await expect(runRemoveAdminUserUseCase(
    { accessToken: null, userId: "target-user" }, gateway,
  )).resolves.toEqual({ status: 401, body: { error: "Unauthorized" } });
  expect(gateway.getUser).not.toHaveBeenCalled();
  expect(gateway.revokeAdminUser).not.toHaveBeenCalled();
});

it("uses one revoke command and leaves the identity gateway untouched", async () => {
  const gateway: RemoveAdminUserGateway = {
    getUser: vi.fn().mockResolvedValue({ user: { id: "admin-1" }, error: null }),
    findAdminUser: vi.fn().mockResolvedValue({ id: "admin-1", role: "admin" }),
    revokeAdminUser: vi.fn().mockResolvedValue({ error: null }),
  };

  await expect(runRemoveAdminUserUseCase(
    { accessToken: "token", userId: "target-user" }, gateway,
  )).resolves.toEqual({ status: 200, body: { revoked: true } });
  expect(gateway.revokeAdminUser).toHaveBeenCalledWith("target-user");
});

it("maps the last-active-human guard without reporting a revoke", async () => {
  const gateway: RemoveAdminUserGateway = {
    getUser: vi.fn().mockResolvedValue({ user: { id: "admin-1" }, error: null }),
    findAdminUser: vi.fn().mockResolvedValue({ id: "admin-1", role: "admin" }),
    revokeAdminUser: vi.fn().mockResolvedValue({ error: { message: "last_active_human_admin" } }),
  };

  await expect(runRemoveAdminUserUseCase(
    { accessToken: "token", userId: "target-user" }, gateway,
  )).resolves.toEqual({
    status: 409,
    body: { error: "At least one active human admin must remain." },
  });
});

it("refuses a machine-actor revoke without reporting success", async () => {
  const gateway: RemoveAdminUserGateway = {
    getUser: vi.fn().mockResolvedValue({ user: { id: "admin-1" }, error: null }),
    findAdminUser: vi.fn().mockResolvedValue({ id: "admin-1", role: "admin" }),
    revokeAdminUser: vi.fn().mockResolvedValue({ error: { message: "machine_actor_revoke_forbidden" } }),
  };

  await expect(runRemoveAdminUserUseCase(
    { accessToken: "token", userId: "machine-1" }, gateway,
  )).resolves.toEqual({
    status: 403,
    body: { error: "Machine actors cannot be revoked through this route." },
  });
});

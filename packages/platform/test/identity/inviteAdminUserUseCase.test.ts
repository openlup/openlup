import { expect, it, vi } from "vitest";

import {
  runInviteAdminUserUseCase,
  type AdminRoleNotificationPort,
  type InviteAdminUserGateway,
} from "../../src/identity/inviteAdminUserUseCase.js";

it("rejects a missing admin session before invite or notification effects", async () => {
  const gateway: InviteAdminUserGateway = {
    getUser: vi.fn(), findAdminUser: vi.fn(), findAdminUserByEmail: vi.fn(),
    findAuthUserByEmail: vi.fn(), inviteAuthUser: vi.fn(),
  };
  const roleNotificationPort: AdminRoleNotificationPort = { sendRoleGranted: vi.fn() };

  await expect(runInviteAdminUserUseCase(
    { accessToken: null, email: "invitee@example.invalid", role: "admin" },
    { gateway, roleNotificationPort, siteUrl: "https://example.invalid", ttlSeconds: 60, invitationStore: {} as never },
  )).resolves.toEqual({ status: 401, body: { code: "UNAUTHORIZED", error: "Unauthorized" } });
  expect(gateway.getUser).not.toHaveBeenCalled();
  expect(roleNotificationPort.sendRoleGranted).not.toHaveBeenCalled();
});

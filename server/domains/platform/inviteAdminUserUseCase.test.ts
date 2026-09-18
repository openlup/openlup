import { expect, it, vi } from "vitest";

import {
  runInviteAdminUserUseCase,
  type AdminRoleNotificationPort,
  type InviteAdminUserGateway,
} from "./inviteAdminUserUseCase.js";

it("rejects a missing admin session before invite or notification effects", async () => {
  const gateway: InviteAdminUserGateway = {
    getUser: vi.fn(), findAdminUser: vi.fn(), findAdminUserByEmail: vi.fn(),
    listAuthUsers: vi.fn(), insertAdminUser: vi.fn(), inviteAuthUser: vi.fn(),
  };
  const roleNotificationPort: AdminRoleNotificationPort = { sendRoleGranted: vi.fn() };

  await expect(runInviteAdminUserUseCase(
    { accessToken: null, email: "invitee@example.invalid", role: "admin" },
    { gateway, roleNotificationPort, siteUrl: "https://example.invalid" },
  )).resolves.toEqual({ status: 401, body: { error: "Unauthorized" } });
  expect(gateway.getUser).not.toHaveBeenCalled();
  expect(roleNotificationPort.sendRoleGranted).not.toHaveBeenCalled();
});

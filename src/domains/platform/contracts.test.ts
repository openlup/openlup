import { describe, expect, it } from "vitest";
import {
  adminMagicLinkRequestSchema,
  adminMagicLinkResponseSchema,
  adminPipelineDhlTrackingRefreshRequestSchema,
  adminPipelineDhlTrackingRefreshResponseSchema,
  adminPlatformMeRequestSchema,
  adminPlatformMeResponseSchema,
  adminPipelineReadRequestSchema,
  adminPipelineReadResponseSchema,
  adminSettingsReadRequestSchema,
  adminSettingsReadResponseSchema,
  adminSettingsUpdateRequestSchema,
  adminSettingsUpdateResponseSchema,
  adminUserInviteRequestSchema,
  adminUserInviteResponseSchema,
  adminUserRemoveRequestSchema,
  adminUserRemoveResponseSchema,
  adminUserRoleUpdateRequestSchema,
  adminUserRoleUpdateResponseSchema,
} from "./contracts";

describe("platform contracts", () => {
  it("validates admin pipeline read contracts", () => {
    expect(adminPipelineReadRequestSchema.parse({})).toEqual({});

    const parsed = adminPipelineReadResponseSchema.parse({
      testers: [
        {
          id: "tester-1",
          status: "packing",
          email_sequence_step: 2,
          email_sequence_paused: false,
        },
      ],
      templates: [{ id: "tpl-1", name: "Reminder", sequence_order: 2 }],
      emailSendCount: 10,
      emailEvents: [{ event_type: "opened" }],
    });

    expect(parsed.testers[0].status).toBe("packing");
    expect(
      adminPipelineReadResponseSchema.parse({
        testers: [
          {
            id: "tester-null-email-sequence",
            status: "pending_review",
            email_sequence_step: null,
            email_sequence_paused: null,
          },
        ],
        templates: [],
        emailSendCount: 0,
        emailEvents: [],
      }).testers[0].email_sequence_step,
    ).toBeNull();
    expect(parsed.emailEvents[0].event_type).toBe("opened");
  });

  it("validates DHL tracking refresh contracts", () => {
    expect(adminPipelineDhlTrackingRefreshRequestSchema.parse({})).toEqual({});
    expect(
      adminPipelineDhlTrackingRefreshResponseSchema.parse({
        checked: 3,
        updated: 2,
      }),
    ).toEqual({ checked: 3, updated: 2 });
  });

  it("validates platform me contracts", () => {
    expect(adminPlatformMeRequestSchema.parse({})).toEqual({});
    expect(adminPlatformMeResponseSchema.parse({ isAdmin: true, role: "admin" })).toEqual({
      isAdmin: true,
      role: "admin",
    });
    expect(adminPlatformMeResponseSchema.parse({ isAdmin: false, role: null })).toEqual({
      isAdmin: false,
      role: null,
    });
    expect(adminPlatformMeResponseSchema.safeParse({ isAdmin: true, role: "owner" }).success).toBe(false);
  });

  it("validates admin magic-link contracts with canonical email normalization", () => {
    expect(adminMagicLinkRequestSchema.parse({ email: " ADMIN@OPENLUP.COM " })).toEqual({
      email: "admin@openlup.com",
    });
    expect(adminMagicLinkRequestSchema.safeParse({ email: "not-an-email" }).success).toBe(false);
    expect(adminMagicLinkResponseSchema.parse({ accepted: true })).toEqual({ accepted: true });
    expect(adminMagicLinkResponseSchema.safeParse({ accepted: false }).success).toBe(false);
  });

  it("validates admin settings read contracts", () => {
    expect(adminSettingsReadRequestSchema.parse({})).toEqual({});

    const parsed = adminSettingsReadResponseSchema.parse({
      settings: {
        tester_cap: 300,
        counter_display: true,
        dhl_shipper_name: "openlup",
      },
      adminUsers: [
        { id: "admin-1", email: "admin@openlup.com", role: "admin" },
        { id: "admin-2", email: "ops@openlup.com", role: "distributor" },
      ],
    });

    expect(parsed.settings.tester_cap).toBe(300);
    expect(parsed.adminUsers[1].role).toBe("distributor");
  });

  it("validates admin settings update contracts", () => {
    expect(
      adminSettingsUpdateRequestSchema.parse({
        key: " tester_cap ",
        value: 250,
      }),
    ).toEqual({ key: "tester_cap", value: 250 });
    expect(adminSettingsUpdateRequestSchema.safeParse({ key: "", value: 250 }).success).toBe(false);
    expect(
      adminSettingsUpdateRequestSchema.safeParse({ key: "x", value: { nested: true } }).success,
    ).toBe(false);
    expect(adminSettingsUpdateResponseSchema.parse({ key: "tester_cap", saved: true })).toEqual({
      key: "tester_cap",
      saved: true,
    });
  });

  it("validates admin user role update contracts", () => {
    expect(
      adminUserRoleUpdateRequestSchema.parse({
        userId: "admin-2",
        role: "distributor",
      }),
    ).toEqual({ userId: "admin-2", role: "distributor" });
    expect(
      adminUserRoleUpdateRequestSchema.safeParse({
        userId: "admin-2",
        role: "owner",
      }).success,
    ).toBe(false);
    expect(
      adminUserRoleUpdateResponseSchema.parse({
        userId: "admin-2",
        role: "admin",
        saved: true,
      }),
    ).toEqual({ userId: "admin-2", role: "admin", saved: true });
  });

  it("validates admin user invite contracts", () => {
    expect(
      adminUserInviteRequestSchema.parse({
        email: " NEW@OPENLUP.COM ",
        role: "admin",
      }),
    ).toEqual({ email: "new@openlup.com", role: "admin" });
    expect(
      adminUserInviteRequestSchema.safeParse({
        email: "not-an-email",
        role: "admin",
      }).success,
    ).toBe(false);
    expect(adminUserInviteResponseSchema.parse({ message: "Zaproszenie wysłane" })).toEqual({
      message: "Zaproszenie wysłane",
    });
  });

  it("validates admin user remove contracts", () => {
    expect(adminUserRemoveRequestSchema.parse({ userId: "admin-2" })).toEqual({
      userId: "admin-2",
    });
    expect(adminUserRemoveRequestSchema.safeParse({ userId: "" }).success).toBe(false);
    expect(
      adminUserRemoveResponseSchema.parse({
        revoked: true,
      }),
    ).toEqual({ revoked: true });
  });
});

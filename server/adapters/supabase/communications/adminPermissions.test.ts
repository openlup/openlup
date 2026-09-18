import { describe, expect, it } from "vitest";
import { createSupabaseAdminPermissionsPort } from "./adminPermissions.js";

describe("createSupabaseAdminPermissionsPort", () => {
  it("exposes read/write permission methods", () => {
    const port = createSupabaseAdminPermissionsPort({} as never);

    expect(port.readByEmail).toBeTypeOf("function");
    expect(port.writePermission).toBeTypeOf("function");
  });
});

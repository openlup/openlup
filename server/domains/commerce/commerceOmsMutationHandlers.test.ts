import { describe, expect, it, vi } from "vitest";
import {
  createAdminCommerceOrderNoteHandler,
  createAdminCommerceOrderUpdateShippingAddressHandler,
} from "./commerceOmsHandlers.js";
import {
  authorize,
  noteRequest,
  noteResponse,
  request,
  response,
  updateShippingAddressRequest,
  updateShippingAddressResponse,
} from "./commerceOmsHandlersTestKit.js";

describe("admin commerce OMS mutation handlers", () => {


  it("passes actor context to enabled support notes", async () => {
    const res = response();
    const port = { addNote: vi.fn().mockResolvedValue(noteResponse()) };

    await createAdminCommerceOrderNoteHandler({
      omsPort: port,
      authorizeAdmin: authorize(),
    })(request("POST", noteRequest()), res);

    expect(port.addNote).toHaveBeenCalledWith({
      ...noteRequest(),
      actorUserId: "admin-user-1",
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });

  it("passes actor context to enabled shipping address corrections", async () => {
    const res = response();
    const port = { updateShippingAddress: vi.fn().mockResolvedValue(updateShippingAddressResponse()) };

    await createAdminCommerceOrderUpdateShippingAddressHandler({
      omsPort: port,
      authorizeAdmin: authorize(),
    })(request("POST", updateShippingAddressRequest()), res);

    expect(port.updateShippingAddress).toHaveBeenCalledWith({
      ...updateShippingAddressRequest(),
      actorUserId: "admin-user-1",
    });
    expect(res.status).toHaveBeenCalledWith(200);
  });
});

import { describe, expect, it, vi } from "vitest";
import { moveIdentityForEmailCorrection, type OperatorIdentityMovePort } from "./operatorIdentityMove.ts";

function port(over: Partial<OperatorIdentityMovePort> = {}): OperatorIdentityMovePort {
  return {
    findLinkedIdentity: vi.fn().mockResolvedValue(null),
    findClientHoldingEmail: vi.fn().mockResolvedValue(null),
    moveIdentityEmail: vi.fn().mockResolvedValue(undefined),
    ...over,
  };
}

describe("moveIdentityForEmailCorrection", () => {
  it("moves the identity when one is linked", async () => {
    const p = port({ findLinkedIdentity: vi.fn().mockResolvedValue({ authUserId: "auth-1" }) });
    await expect(moveIdentityForEmailCorrection({ port: p, subjectId: "c-1", newEmail: "new@example.test" }))
      .resolves.toEqual({ moved: true, blockedByHolder: false, holderId: null });
    expect(p.moveIdentityEmail).toHaveBeenCalledWith("auth-1", "new@example.test");
  });

  it("moves nothing when no identity is linked", async () => {
    const p = port();
    await expect(moveIdentityForEmailCorrection({ port: p, subjectId: "c-1", newEmail: "new@example.test" }))
      .resolves.toEqual({ moved: false, blockedByHolder: false, holderId: null });
    expect(p.moveIdentityEmail).not.toHaveBeenCalled();
  });

  // The ordering guarantee, and the reason the check is here rather than only in SQL:
  // the commonest refusal an operator hits must not leave the auth service mutated.
  // The holder's id comes back with the refusal because the console needs it to offer
  // absorption; resolving it is what this function already had to do to decide.
  it("does not touch the identity when another record holds the address", async () => {
    const p = port({
      findClientHoldingEmail: vi.fn().mockResolvedValue({ clientId: "c-2" }),
      findLinkedIdentity: vi.fn().mockResolvedValue({ authUserId: "auth-1" }),
    });
    await expect(moveIdentityForEmailCorrection({ port: p, subjectId: "c-1", newEmail: "taken@example.test" }))
      .resolves.toEqual({ moved: false, blockedByHolder: true, holderId: "c-2" });
    expect(p.moveIdentityEmail).not.toHaveBeenCalled();
    expect(p.findLinkedIdentity).not.toHaveBeenCalled();
  });

  // A subject already holding the address is not a conflict with itself: correcting
  // case or whitespace must still move the identity rather than being refused.
  it("proceeds when the holder is the subject itself", async () => {
    const p = port({
      findClientHoldingEmail: vi.fn().mockResolvedValue({ clientId: "c-1" }),
      findLinkedIdentity: vi.fn().mockResolvedValue({ authUserId: "auth-1" }),
    });
    // No holder is reported here on purpose: the subject is not in its own way, and
    // naming it would make the console offer to absorb the customer into herself.
    await expect(moveIdentityForEmailCorrection({ port: p, subjectId: "c-1", newEmail: "same@example.test" }))
      .resolves.toEqual({ moved: true, blockedByHolder: false, holderId: null });
  });

  it("lets a failed identity move surface instead of writing the record anyway", async () => {
    const p = port({
      findLinkedIdentity: vi.fn().mockResolvedValue({ authUserId: "auth-1" }),
      moveIdentityEmail: vi.fn().mockRejectedValue(new Error("auth_service_unavailable")),
    });
    await expect(moveIdentityForEmailCorrection({ port: p, subjectId: "c-1", newEmail: "new@example.test" }))
      .rejects.toThrow("auth_service_unavailable");
  });
});

import { describe, expect, it } from "vitest";

import handler from "./dhl-tracking.ts";

// Request/response types derive from the handler's own signature so this
// companion pins no hosting-SDK vocabulary and follows the signature if it moves.
type HandlerArgs = Parameters<typeof handler>;

describe("cron route handler (companion)", () => {
  it("executes the handler and denies by default without cron auth", async () => {
    const req = { method: "GET", headers: {} } as HandlerArgs[0];
    let statusCode = 0;
    let body: unknown = null;
    const res = {
      status(code: number) {
        statusCode = code;
        return this;
      },
      json(payload: unknown) {
        body = payload;
        return this;
      },
    } as unknown as HandlerArgs[1];

    await handler(req, res);

    // No CRON_SECRET / bearer in the test env → the job denies before any work.
    expect(statusCode).toBeGreaterThanOrEqual(400);
    expect(body).toMatchObject({ ok: false });
  });
});

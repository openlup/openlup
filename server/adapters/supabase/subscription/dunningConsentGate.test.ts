import { describe, expect, it } from "vitest";
import { createSupabaseDunningConsentGate } from "./dunningConsentGate.js";

const signal = new AbortController().signal;
const request = {
  recipientEmail: " Kot@Example.COM ",
  notificationKind: "payment_failed",
  templateSlug: "subscription-payment-failed-1",
  signal,
};

type Reply = { data?: unknown; error?: { message?: string } | null; throws?: boolean };

function client(contact: Reply, permissions: Reply = { data: [] }) {
  const ops: Array<[string, ...unknown[]]> = [];
  const build = (reply: Reply, terminal: "maybeSingle" | "in") => {
    const q: Record<string, unknown> = {};
    for (const fn of ["select", "eq"]) {
      q[fn] = (...args: unknown[]) => { ops.push([fn, ...args]); return q; };
    }
    const settle = () => {
      if (reply.throws) throw new Error("read exploded");
      return Promise.resolve({ data: reply.data ?? null, error: reply.error ?? null });
    };
    q.maybeSingle = () => { ops.push(["maybeSingle"]); return terminal === "maybeSingle" ? settle() : Promise.resolve({ data: null, error: null }); };
    q.in = (...args: unknown[]) => { ops.push(["in", ...args]); return settle(); };
    return q;
  };
  return {
    ops,
    gate: createSupabaseDunningConsentGate({
      from: (table: string) => {
        ops.push(["from", table]);
        return build(table === "communication_contacts" ? contact : permissions,
          table === "communication_contacts" ? "maybeSingle" : "in") as never;
      },
    }),
  };
}

describe("managed dunning consent gate", () => {
  it("refuses only on a recorded denial, and normalizes the address it looks up", async () => {
    const { gate, ops } = client(
      { data: { id: "contact-1" } },
      { data: [{ purpose: "subscription_dunning", state: "denied" }] },
    );
    expect(await gate.evaluate(request)).toEqual({ verdict: "refuse", refusalCode: "consent_denied" });
    expect(ops).toContainEqual(["eq", "normalized_email", "kot@example.com"]);
    expect(ops).toContainEqual(["eq", "contact_id", "contact-1"]);
    expect(ops).toContainEqual(["eq", "channel", "email"]);
    expect(ops).toContainEqual(["in", "purpose", ["subscription_dunning", "transactional"]]);
  });

  it("treats a blanket transactional suppression as meaning this notice too", async () => {
    const { gate } = client(
      { data: { id: "contact-1" } },
      { data: [{ purpose: "transactional", state: "suppressed" }] },
    );
    expect(await gate.evaluate(request)).toEqual({ verdict: "refuse", refusalCode: "consent_denied" });
  });

  it("sends for every state that is not an explicit refusal", async () => {
    for (const state of ["granted", "unknown", "pending", null]) {
      const { gate } = client({ data: { id: "contact-1" } }, { data: [{ purpose: "transactional", state }] });
      expect(await gate.evaluate(request), `state ${state}`).toEqual({ verdict: "allow" });
    }
  });

  it("sends when nothing about this person is recorded at all", async () => {
    const { gate } = client({ data: null });
    expect(await gate.evaluate(request)).toEqual({ verdict: "allow" });

    const noRows = client({ data: { id: "contact-1" } }, { data: [] });
    expect(await noRows.gate.evaluate(request)).toEqual({ verdict: "allow" });
  });

  it("sends on every unreadable answer, because a wrong silence cancels a customer", async () => {
    const contactError = client({ data: null, error: { message: "down" } });
    expect(await contactError.gate.evaluate(request)).toEqual({ verdict: "allow" });

    const permissionError = client({ data: { id: "contact-1" } }, { data: null, error: { message: "down" } });
    expect(await permissionError.gate.evaluate(request)).toEqual({ verdict: "allow" });

    const thrown = client({ data: { id: "contact-1" } }, { throws: true });
    expect(await thrown.gate.evaluate(request)).toEqual({ verdict: "allow" });

    const shapeless = client({ data: { id: 42 } });
    expect(await shapeless.gate.evaluate(request)).toEqual({ verdict: "allow" });
  });

  it("asks nothing at all when there is no address to ask about", async () => {
    const { gate, ops } = client({ data: { id: "contact-1" } });
    expect(await gate.evaluate({ ...request, recipientEmail: "   " })).toEqual({ verdict: "allow" });
    expect(ops).toEqual([]);
  });
});

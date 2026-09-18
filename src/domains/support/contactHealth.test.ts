import { describe, expect, it } from "vitest";
import { deriveContactHealth } from "./contactHealth.js";

const at = (day: number) => `2026-08-${String(day).padStart(2, "0")}T10:00:00.000Z`;

describe("deriveContactHealth", () => {
  it("reports a permanent bounce as unreachable", () => {
    expect(deriveContactHealth([
      { status: "bounced", occurredAt: at(10), permanentBounce: true },
    ])).toEqual({ lastTerminalStatus: "bounced", lastTerminalAt: at(10), reachable: false });
  });

  it("lets a later delivery clear an earlier permanent bounce", () => {
    expect(deriveContactHealth([
      { status: "bounced", occurredAt: at(10), permanentBounce: true },
      { status: "delivered", occurredAt: at(11), permanentBounce: null },
    ])).toMatchObject({ lastTerminalStatus: "delivered", lastTerminalAt: at(11), reachable: true });
  });

  it("does not let an earlier delivery mask a later permanent bounce", () => {
    expect(deriveContactHealth([
      { status: "delivered", occurredAt: at(11), permanentBounce: null },
      { status: "bounced", occurredAt: at(12), permanentBounce: true },
    ])).toMatchObject({ lastTerminalStatus: "bounced", reachable: false });
  });

  it("keeps a transient bounce reachable", () => {
    expect(deriveContactHealth([
      { status: "bounced", occurredAt: at(10), permanentBounce: false },
    ])).toMatchObject({ lastTerminalStatus: "bounced", reachable: true });
  });

  it("treats an unclassified bounce as permanent", () => {
    expect(deriveContactHealth([
      { status: "bounced", occurredAt: at(10), permanentBounce: null },
    ])).toMatchObject({ reachable: false });
  });

  it("treats a complaint and a hard failure as unreachable", () => {
    expect(deriveContactHealth([
      { status: "complained", occurredAt: at(10), permanentBounce: null },
    ])).toMatchObject({ lastTerminalStatus: "complained", reachable: false });
    expect(deriveContactHealth([
      { status: "failed", occurredAt: at(10), permanentBounce: null },
    ])).toMatchObject({ lastTerminalStatus: "failed", reachable: false });
  });

  it("ignores suppressed and in-flight statuses entirely", () => {
    for (const status of ["skipped", "blocked", "queued", "sent", "processing", "delivery_delayed", "missed"]) {
      expect(deriveContactHealth([{ status, occurredAt: at(10), permanentBounce: null }])).toEqual({
        lastTerminalStatus: null, lastTerminalAt: null, reachable: true,
      });
    }
  });

  it("does not let a suppressed send hide the bounce underneath it", () => {
    expect(deriveContactHealth([
      { status: "bounced", occurredAt: at(10), permanentBounce: true },
      { status: "skipped", occurredAt: at(20), permanentBounce: null },
    ])).toMatchObject({ lastTerminalStatus: "bounced", reachable: false });
  });

  it("reports no evidence as reachable", () => {
    expect(deriveContactHealth([])).toEqual({
      lastTerminalStatus: null, lastTerminalAt: null, reachable: true,
    });
  });

  it("ignores terminal rows that carry no time", () => {
    expect(deriveContactHealth([
      { status: "bounced", occurredAt: null, permanentBounce: true },
    ])).toEqual({ lastTerminalStatus: null, lastTerminalAt: null, reachable: true });
  });
});

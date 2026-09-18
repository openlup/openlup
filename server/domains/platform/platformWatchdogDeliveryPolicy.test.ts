import { describe, expect, it } from "vitest";
import {
  isActionabilitySuppressed,
  isDeliveryBackoff,
  isPagingSuppressed,
  isSeverityEscalation,
  notificationSchedule,
  shouldAttemptNotification,
} from "./platformWatchdogDeliveryPolicy.js";

const now = new Date("2026-07-26T12:00:00.000Z");

describe("platform watchdog delivery policy", () => {
  it("backs off failed delivery exponentially and does not retry before its persisted deadline", () => {
    const schedule = notificationSchedule(
      { notificationFailureCount: 1 },
      { channel: "webhook", status: "failed", error: "timeout" },
      now,
      3600,
    );

    expect(schedule).toEqual({
      failureCount: 2,
      nextAttemptAt: new Date("2026-07-26T12:20:00.000Z"),
    });
    expect(isDeliveryBackoff({ lastNotificationStatus: "failed", nextNotificationAttemptAt: schedule.nextAttemptAt.toISOString() }, now))
      .toBe(true);
    expect(shouldAttemptNotification({
      lastNotifiedAt: null,
      lastNotificationStatus: "failed",
      nextNotificationAttemptAt: schedule.nextAttemptAt.toISOString(),
      snoozedUntil: null,
    }, now, 3600)).toBe(false);
  });

  it("caps a repeated failed retry at one hour, then resets failure state for sent and skipped outcomes", () => {
    expect(notificationSchedule(
      { notificationFailureCount: 16 },
      { channel: "webhook", status: "failed", error: "timeout" },
      now,
      900,
    )).toEqual({ failureCount: 17, nextAttemptAt: new Date("2026-07-26T13:00:00.000Z") });

    for (const status of ["sent", "skipped"] as const) {
      expect(notificationSchedule({ notificationFailureCount: 7 }, { channel: "webhook", status }, now, 900))
        .toEqual({ failureCount: 0, nextAttemptAt: new Date("2026-07-26T12:15:00.000Z") });
    }
  });

  it("re-pages immediately after a snooze that expires after its last delivery", () => {
    expect(shouldAttemptNotification({
      lastNotifiedAt: "2026-07-26T11:00:00.000Z",
      lastNotificationStatus: "sent",
      nextNotificationAttemptAt: "2026-07-26T15:00:00.000Z",
      snoozedUntil: "2026-07-26T11:30:00.000Z",
    }, now, 4 * 60 * 60)).toBe(true);
  });

  it("keeps acknowledgement page-suppressed but actionable, while an active snooze suppresses both", () => {
    const acknowledged = { status: "acknowledged" as const, snoozedUntil: null };
    const snoozed = { status: "open" as const, snoozedUntil: "2026-07-26T13:00:00.000Z" };

    expect(isPagingSuppressed(acknowledged, now)).toBe(true);
    expect(isActionabilitySuppressed(acknowledged, now)).toBe(false);
    expect(isPagingSuppressed(snoozed, now)).toBe(true);
    expect(isActionabilitySuppressed(snoozed, now)).toBe(true);
    expect(isSeverityEscalation({ severity: "p0" }, { severity: "p1" })).toBe(true);
    expect(isSeverityEscalation({ severity: "p1" }, { severity: "p1" })).toBe(false);
    expect(isSeverityEscalation({ severity: "p2" }, { severity: "p1" })).toBe(false);
  });

  it("does not call skipped or malformed delivery state an active backoff", () => {
    expect(isDeliveryBackoff({
      lastNotificationStatus: "skipped",
      nextNotificationAttemptAt: "2026-07-26T13:00:00.000Z",
    }, now)).toBe(false);
    expect(isDeliveryBackoff({
      lastNotificationStatus: "failed",
      nextNotificationAttemptAt: "not-a-date",
    }, now)).toBe(false);
  });
});

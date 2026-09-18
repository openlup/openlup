import { describe, expect, it } from "vitest";
import {
  isNtfyWebhookUrl,
  ntfyPriorityForSeverity,
  sanitizeNtfyHeader,
} from "./ntfyAlertFormat";

describe("ntfy alert format", () => {
  it("maps severity to ntfy priority, p0 loudest", () => {
    expect(ntfyPriorityForSeverity("p0")).toBe(5);
    expect(ntfyPriorityForSeverity("p1")).toBe(4);
    expect(ntfyPriorityForSeverity("p2")).toBe(3);
    expect(ntfyPriorityForSeverity("p3")).toBe(2);
    expect(ntfyPriorityForSeverity("weird")).toBe(5); // fail-loud
  });

  it("detects ntfy hosts (ntfy.sh + self-hosted), rejects others and junk", () => {
    expect(isNtfyWebhookUrl("https://ntfy.sh/openlup-prod-alerts")).toBe(true);
    expect(isNtfyWebhookUrl("https://ntfy.example.com/topic")).toBe(true);
    expect(isNtfyWebhookUrl("https://outlook.office.com/webhook/abc")).toBe(false);
    expect(isNtfyWebhookUrl("not-a-url")).toBe(false);
    expect(isNtfyWebhookUrl("https://myntfy.evil.com/x")).toBe(false);
  });

  it("makes header values ascii + single-line", () => {
    expect(sanitizeNtfyHeader("Edycja płatności — błąd")).toBe("Edycja platnosci ? blad");
    expect(sanitizeNtfyHeader("line1\nline2\ttab")).toBe("line1 line2 tab");
  });
});

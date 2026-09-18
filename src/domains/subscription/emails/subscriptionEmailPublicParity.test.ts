import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { subscriptionEmailContent } from "./exampleSubscriptionEmailContent.js";

const FORBIDDEN = /velipet|\bveli\b|\bpies\b|\bpsa\b|\bpupil\b|\bkarma\b|pusz|\bblik\b|merda|ogon|\bpet\b|\bdog\b|\bfood\b|\bcans\b/i;

const CHILD_MATRIX_SCRIPT = String.raw`
  const paths = [
    "subscriptionActivationActionRequired", "subscriptionAddressChanged", "subscriptionCancelled",
    "subscriptionCycleSkipped", "subscriptionDeliveryRescheduled", "subscriptionPackageChanged",
    "subscriptionPauseReminder", "subscriptionPaused", "subscriptionPaymentExpired",
    "subscriptionPaymentFailed", "subscriptionPaymentRecovered", "subscriptionRenewalAtRisk",
    "subscriptionRenewalUpcoming", "subscriptionResumed", "subscriptionWelcome", "subscriptionWinback",
  ];
  const [{ subscriptionEmailContent }, { renderEmail }, brandModule, ...modules] = await Promise.all([
    import("#subscription-email-content"),
    import("./src/domains/communications/email/render.ts"),
    import("./src/lib/brand/appBrand.ts"),
    ...paths.map((name) => import("./src/domains/subscription/emails/" + name + ".ts")),
  ]);
  const vars = {
    firstName: "Alex", brandName: "Example Store", contextName: "Workspace", action: "update_plan_length",
    ctaUrl: "https://example.invalid/account", recoveryUrl: "https://example.invalid/recovery",
    cadenceDays: 30, chargeDateLabel: "Sep 20", deliveryWindowLabel: "Sep 21–22",
    editCutoffLabel: "Sep 17", holidayNote: null, amountLabel: "12.00 USD", retryAttempt: 3,
    nextRetryDateLabel: "Sep 20", methodScheme: "visa", methodLastDigits: "4242",
    cause: "method_dead", renewalDateLabel: "Sep 20", starterStage: "graduation",
    starterAmountLabel: "6.00 USD", starterSteadyUnitCount: 2, starterSteadyCadenceDays: 30,
  };
  const entries = [];
  for (let index = 0; index < modules.length; index += 1) {
    const builder = Object.values(modules[index]).find((value) => typeof value === "function");
    for (const locale of ["pl", "en"]) {
      const familyVars = paths[index] === "subscriptionRenewalAtRisk" ? { ...vars, cause: "mandate" } : vars;
      const content = builder(locale, familyVars, brandModule.APP_EMAIL_TEAM_SIGNOFF[locale]);
      const rendered = renderEmail({ brand: brandModule.APP_EMAIL_BRAND, locale, ...content });
      entries.push({ family: paths[index], locale, kinds: content.blocks.map((block) => block.kind), ...rendered });
    }
  }
  process.stdout.write(JSON.stringify({ id: subscriptionEmailContent.id, entries }));
`;

function proseValues(value: unknown): string[] {
  if (typeof value === "string") return [value];
  if (Array.isArray(value)) return value.flatMap(proseValues);
  if (value && typeof value === "object") return Object.values(value).flatMap(proseValues);
  return [];
}

describe("public subscription email content", () => {
  it("is useful in both locales without deployment or vertical prose", () => {
    const prose = proseValues(subscriptionEmailContent);
    expect(prose.length).toBeGreaterThan(150);
    expect(prose.join("\n")).not.toMatch(FORBIDDEN);
    const publicSources = [
      "exampleSubscriptionLifecycleEmailContent.ts",
      "exampleSubscriptionDunningEmailContent.ts",
      "exampleSubscriptionEmailContent.ts",
    ].map((file) => readFileSync(new URL(file, import.meta.url), "utf8")).join("\n");
    expect(publicSources).not.toMatch(FORBIDDEN);
    for (const locale of ["pl", "en"] as const) {
      expect(subscriptionEmailContent.paymentFailed[locale].cta.length).toBeGreaterThan(8);
      expect(subscriptionEmailContent.renewalUpcoming[locale].manageLine.length).toBeGreaterThan(40);
      expect(subscriptionEmailContent.welcome[locale].fallbackLine.length).toBeGreaterThan(30);
      expect(subscriptionEmailContent.paymentExpired[locale].ctaDetail.length).toBeGreaterThan(50);
    }
  });

  it("keeps dynamic copy useful for names, amounts, dates and retry branches", () => {
    expect(subscriptionEmailContent.renewalUpcoming.pl.intro("Kontekst")).toContain("Kontekst");
    expect(subscriptionEmailContent.paymentRecovered.en.detail("12.00 USD")[0]).toContain("12.00 USD");
    expect(subscriptionEmailContent.renewalAtRisk.pl.intro("12.09.2026")).toContain("12.09.2026");
    expect(subscriptionEmailContent.paymentFailed.en.reassurance(3, "Sep 12, 2026")).toContain("Sep 12, 2026");
    expect(subscriptionEmailContent.paymentFailed.en.noRetryAction).not.toMatch(/retry automatically/i);
  });

  it("self-selects and renders every public family in both locales", () => {
    const child = spawnSync(process.execPath, [
      "--conditions=core-source", "--import", "tsx", "--input-type=module", "--eval", CHILD_MATRIX_SCRIPT,
    ], { cwd: process.cwd(), encoding: "utf8" });
    expect(child.status, child.stderr).toBe(0);
    const result = JSON.parse(child.stdout) as {
      id: string;
      entries: Array<{ family: string; locale: string; kinds: string[]; html: string; text: string }>;
    };
    expect(result.id).toBe("example");
    expect(result.entries).toHaveLength(32);
    for (const entry of result.entries) {
      expect(entry.html.length).toBeGreaterThan(500);
      expect(entry.text.length).toBeGreaterThan(100);
      expect(`${entry.html}\n${entry.text}`).not.toMatch(FORBIDDEN);
      if (entry.family === "subscriptionPaymentRecovered") {
        expect(entry.kinds).not.toContain("button");
      } else {
        expect(entry.kinds).toContain("button");
      }
    }
  });
});

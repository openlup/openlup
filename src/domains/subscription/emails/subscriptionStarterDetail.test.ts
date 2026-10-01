import { beforeEach, describe, expect, it, vi } from "vitest";
import type { Locale } from "../../../lib/i18n/resolveLocale.js";
import { paragraph, type EmailBlock } from "../../communications/email/blocks.js";
import type {
  SubscriptionEmailContent,
  SubscriptionRenewalUpcomingCopy,
  SubscriptionWelcomeCopy,
} from "./subscriptionEmailContent.js";
import { subscriptionRenewalUpcomingEmailContent, type SubscriptionRenewalUpcomingEmailVars } from "./subscriptionRenewalUpcoming.js";
import { subscriptionWelcomeEmailContent, type SubscriptionWelcomeEmailVars } from "./subscriptionWelcome.js";

// Every call of the two starter lines is recorded and still answered by the
// composed copy, so each assertion compares with that copy's own answer and
// holds for any deployment's copy, not only the example one.
const calls = vi.hoisted(() => ({
  steady: [] as Array<{ args: unknown[]; line: string }>,
  graduation: [] as Array<{ args: unknown[]; line: string }>,
}));

vi.mock("#subscription-email-content", async (importOriginal) => {
  const original = await importOriginal<typeof import("#subscription-email-content")>();
  // Read through the public copy contract, whatever narrower type a deployment's copy has.
  const { welcome, renewalUpcoming }: SubscriptionEmailContent = original.subscriptionEmailContent;
  const recordedWelcome = (locale: Locale): SubscriptionWelcomeCopy => ({
    ...welcome[locale],
    starterSteadyLine: (...args) => {
      const line = welcome[locale].starterSteadyLine(...args);
      calls.steady.push({ args, line });
      return line;
    },
  });
  const recordedReminder = (locale: Locale): SubscriptionRenewalUpcomingCopy => ({
    ...renewalUpcoming[locale],
    starterGraduationLine: (...args) => {
      const line = renewalUpcoming[locale].starterGraduationLine(...args);
      calls.graduation.push({ args, line });
      return line;
    },
  });
  return {
    ...original,
    subscriptionEmailContent: {
      ...original.subscriptionEmailContent,
      welcome: { pl: recordedWelcome("pl"), en: recordedWelcome("en") },
      renewalUpcoming: { pl: recordedReminder("pl"), en: recordedReminder("en") },
    },
  };
});

const LOCALES: Locale[] = ["pl", "en"];
const SIGNOFF = "Example Team";
const DETAIL = "adopter detail";

const WELCOME: SubscriptionWelcomeEmailVars = {
  firstName: "Alex",
  cadenceDays: 14,
  chargeDateLabel: "Sep 20",
  deliveryWindowLabel: "Sep 21-22",
  starterAmountLabel: "6.00 USD",
  starterSteadyUnitCount: 2,
  starterSteadyCadenceDays: 30,
};

const REMINDER: SubscriptionRenewalUpcomingEmailVars = {
  firstName: "Alex",
  renewalDateLabel: "Sep 20",
  amountLabel: "12.00 USD",
  starterStage: "graduation",
  starterSteadyUnitCount: 2,
  starterSteadyCadenceDays: 30,
};
const OUTSIDE_GRADUATION: SubscriptionRenewalUpcomingEmailVars["starterStage"][] = ["delivery2", null];

/** The same blocks with one copy line swapped, wherever the content placed it. */
function withLine(blocks: EmailBlock[], from: string, to: string): EmailBlock[] {
  return blocks.map((block) => {
    if (block.kind === "accentBox") return { ...block, lines: block.lines.map((line) => (line === from ? to : line)) };
    return block.kind === "paragraph" && block.text === from ? { ...block, text: to } : block;
  });
}

async function actualCopy(): Promise<SubscriptionEmailContent> {
  return (await vi.importActual<typeof import("#subscription-email-content")>("#subscription-email-content"))
    .subscriptionEmailContent;
}

beforeEach(() => {
  calls.steady.length = 0;
  calls.graduation.length = 0;
});

describe.each(LOCALES)("adopter-formatted starter detail (%s)", (locale) => {
  it("welcome without a detail hands the copy none and renders today's steady line, exactly as with null", async () => {
    const today = subscriptionWelcomeEmailContent(locale, WELCOME, SIGNOFF);
    expect(calls.steady.map((call) => call.args)).toEqual([[2, 30, undefined]]);
    expect(calls.steady[0]?.line).toBe((await actualCopy()).welcome[locale].starterSteadyLine(2, 30, undefined));
    expect(subscriptionWelcomeEmailContent(locale, { ...WELCOME, starterSteadyDetail: null }, SIGNOFF)).toEqual(today);
  });

  it("welcome hands the detail to the steady line and changes nothing else", () => {
    const today = subscriptionWelcomeEmailContent(locale, WELCOME, SIGNOFF);
    const withDetail = subscriptionWelcomeEmailContent(locale, { ...WELCOME, starterSteadyDetail: DETAIL }, SIGNOFF);
    expect(calls.steady.map((call) => call.args)).toEqual([[2, 30, undefined], [2, 30, DETAIL]]);
    expect(withDetail).toEqual({ ...today, blocks: withLine(today.blocks, calls.steady[0]!.line, calls.steady[1]!.line) });
  });

  it("a detail without the steady pair changes nothing and never reaches the copy", () => {
    const withoutPair = { ...WELCOME, starterSteadyUnitCount: null, starterSteadyCadenceDays: null };
    const today = subscriptionWelcomeEmailContent(locale, withoutPair, SIGNOFF);
    expect(subscriptionWelcomeEmailContent(locale, { ...withoutPair, starterSteadyDetail: DETAIL }, SIGNOFF)).toEqual(today);
    expect(calls.steady).toEqual([]);
  });

  it("the graduation reminder renders today's paragraph without a detail and hands a detail to the copy", async () => {
    const today = subscriptionRenewalUpcomingEmailContent(locale, REMINDER, SIGNOFF);
    const todayLine = (await actualCopy()).renewalUpcoming[locale].starterGraduationLine(2, 30, undefined);
    expect(today.blocks).toContainEqual(paragraph(todayLine));
    const withDetail = subscriptionRenewalUpcomingEmailContent(locale, { ...REMINDER, starterSteadyDetail: DETAIL }, SIGNOFF);
    expect(calls.graduation.map((call) => call.args)).toEqual([[2, 30, undefined], [2, 30, DETAIL]]);
    expect(calls.graduation[0]?.line).toBe(todayLine);
    expect(withDetail).toEqual({ ...today, blocks: withLine(today.blocks, todayLine, calls.graduation[1]!.line) });
  });

  it.each(OUTSIDE_GRADUATION)("a detail outside the graduation (%s) renders nothing new", (starterStage) => {
    const outside = { ...REMINDER, starterStage };
    const today = subscriptionRenewalUpcomingEmailContent(locale, outside, SIGNOFF);
    expect(subscriptionRenewalUpcomingEmailContent(locale, { ...outside, starterSteadyDetail: DETAIL }, SIGNOFF)).toEqual(today);
    expect(calls.graduation).toEqual([]);
  });
});

import { fileURLToPath } from "node:url";
import ts from "typescript";
import { expect, it } from "vitest";
import * as contracts from "../../src/communications/contracts/index.js";
import type { AuthEmailContentPort, EmailBrand, NewsletterSyncProviderPort, TransactionalDeliveryReceiptStore } from "../../src/communications/contracts/index.js";

it("exposes pure rendering values and type ports without loading a server runtime", () => {
  const types: [AuthEmailContentPort?, EmailBrand?, NewsletterSyncProviderPort?, TransactionalDeliveryReceiptStore?] = [];
  expect(types).toEqual([]);
  expect(Object.keys(contracts).sort()).toEqual(["accentBox","button","createAbandonedCartContentFactory","createBackInStockContentFactory","createCheckoutExpiredContentFactory","createCheckoutRecoveryContentFactory","createOrderCanceledContentFactory","createOrderDraftContentFactory","createOrderPaidContentFactory","createOrderRefundedContentFactory","createPaymentFailedContentFactory","createReorderReminderContentFactory","createReturnEmailsContentFactory","createReviewEffectsContentFactory","createReviewRequestContentFactory","createShipmentDeliveredContentFactory","createShipmentDispatchedContentFactory","createShipmentExceptionContentFactory","createSubscriptionActivationActionRequiredContentFactory","createSubscriptionAddressChangedContentFactory","createSubscriptionCancelledContentFactory","createSubscriptionCycleSkippedContentFactory","createSubscriptionDeliveryRescheduledContentFactory","createSubscriptionPackageChangedContentFactory","createSubscriptionPauseReminderContentFactory","createSubscriptionPausedContentFactory","createSubscriptionPaymentExpiredContentFactory","createSubscriptionPaymentFailedContentFactory","createSubscriptionPaymentRecoveredContentFactory","createSubscriptionRenewalAtRiskContentFactory","createSubscriptionRenewalUpcomingContentFactory","createSubscriptionResumedContentFactory","createSubscriptionWelcomeContentFactory","createSubscriptionWinbackContentFactory","dataTable","divider","featureCard","guideCardBlock","heading","linkParagraph","list","paragraph","renderEmail"]);
  const entry = fileURLToPath(new URL("../../src/communications/contracts/index.ts", import.meta.url));
  const program = ts.createProgram([entry], {
    target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext,
    moduleResolution: ts.ModuleResolutionKind.Bundler, strict: true, noEmit: true,
    types: [], lib: ["lib.es2022.d.ts", "lib.dom.d.ts"],
  });
  const closure = program.getSourceFiles().map(file => file.fileName.replaceAll("\\", "/"));
  expect(closure.filter(path => path.includes("/communications/") && !path.includes("/communications/contracts/"))).toEqual([]);
  expect(closure.some(path => path.includes("/@types/node/") || path.includes("/zod/"))).toBe(false);
  expect(ts.getPreEmitDiagnostics(program).map(diagnostic => ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"))).toEqual([]);
}, 30_000);

const brand: EmailBrand = { copyBrandName: "Example", theme: { bodyBg: "#fff", cardBg: "#fff", accentBg: "#eee", hairline: "#ccc", brand: "#123", onBrand: "#fff", textHeading: "#111", textBody: "#222", textMuted: "#555", fontFamily: "Arial", logoText: "Example", cardRadiusPx: 12, buttonRadiusPx: 8, maxWidthPx: 600 }, chrome: { pl: { logoAlt: "Example", footerTagline: "Polish footer" }, en: { logoAlt: "Example", footerTagline: "EN footer" } } };

it("renders escaped blocks with host chrome and refuses unsafe inline links", () => {
  const rendered = contracts.renderEmail({ brand, locale: "en", subject: "Synthetic", blocks: [contracts.heading("<heading>"), contracts.paragraph("**bold** [safe](https://example.test) [bad](javascript:alert)"), contracts.divider()] });
  expect(rendered.subject).toBe("Synthetic");
  expect(rendered.html).toContain("&lt;heading&gt;");
  expect(rendered.html).toContain('href="https://example.test"');
  expect(rendered.html).not.toContain('href="javascript:');
  expect(rendered.text).toContain("EN footer");
});

it("keeps optional own properties in constructors and injected marketing footer ordering", () => {
  expect(contracts.paragraph("text", { muted: false, afterCard: false })).toEqual({ kind: "paragraph", text: "text", muted: false });
  expect(Object.hasOwn(contracts.accentBox([]), "label")).toBe(true);
  expect(Object.hasOwn(contracts.dataTable([]), "link")).toBe(false);
  const tone = { subject: "Subject {{brand}}", preheader: "Preview", heading: "Heading", intro: "Intro", body: "Body", cta: "Go" };
  const footer = [contracts.divider(), contracts.paragraph("Host footer")];
  const factory = contracts.createAbandonedCartContentFactory({ commerceEmailContent: { abandonedCart: { pl: { greeting: () => "Hello", first: tone, gentle: tone, last: tone }, en: { greeting: () => "Hello", first: tone, gentle: tone, last: tone } } }, marketingUnsubscribeFooter: () => footer });
  const result = factory.abandonedCartEmailContent("en", { firstName: null, brandName: "Example", reminderHours: 72, ctaUrl: "https://example.test", unsubscribeUrl: "https://example.test/unsubscribe" }, "Signoff");
  expect(result.subject).toBe("Subject Example");
  expect(result.blocks.slice(-3)).toEqual([contracts.paragraph("Signoff"), ...footer]);
});

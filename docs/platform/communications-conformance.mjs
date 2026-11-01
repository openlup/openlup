import assert from "node:assert/strict";
import { runCommunicationsAdapterConformance } from "@openlup/platform/communications";

// Synthetic data and injected outcomes only. No provider, network or credentials.
const accepted = { outcome: { ok: true, resendId: "notice:1", httpStatus: 202, providerError: null, aborted: false }, providerResponse: { id: "notice:1" } };
const failed = { outcome: { ok: false, resendId: null, httpStatus: 503, providerError: "unavailable", aborted: false }, providerResponse: {} };
const suppressed = { outcome: { ok: false, resendId: null, httpStatus: 0, providerError: null, aborted: false, suppressed: "drop" }, providerResponse: {} };
const message = { from: "sender@example.invalid", to: "reader@example.invalid", subject: "accepted", html: "<p>Notice</p>" };

function subject(bad) {
  return {
    kind: "email", subjectId: "offline-mail",
    create() {
      let effects = 0;
      return {
        readEffectCount: () => effects,
        adapter: {
          providerKind: "offline",
          async send(input) {
            if (input.subject === "suppressed") return suppressed;
            effects++;
            // The defect: a failed provider response is reported as accepted.
            return input.subject === "failed" && !bad ? failed : accepted;
          },
        },
      };
    },
    fixtures: [
      { input: message, expected: accepted, expectedEffects: 1 },
      { input: { ...message, subject: "failed" }, expected: failed, expectedEffects: 1 },
      { input: { ...message, subject: "suppressed" }, expected: suppressed, expectedEffects: 0 },
    ],
  };
}

await assert.rejects(() => runCommunicationsAdapterConformance([subject(true)]), error => {
  assert.match(error.message, /^COMMUNICATIONS_CONFORMANCE:email_fixture\./);
  assert.match(error.message, /Match the expected email outcome/);
  assert.match(error.message, /Recheck with runCommunicationsAdapterConformance/);
  console.log(error.message);
  return true;
});
const evidence = await runCommunicationsAdapterConformance([subject(false)]);
assert.deepEqual(evidence.subjects[0].cases, ["email:accepted", "email:failed", "email:suppressed"]);
console.log("Corrected offline adapter PASS");

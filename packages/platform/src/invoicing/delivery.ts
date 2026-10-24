import type { InvoiceUnsupported } from "./contracts/provider.js";
import type { InvoiceStorePort } from "./contracts/store.js";
import type { InvoiceDeliveryPort } from "./contracts/delivery.js";
import { assertInvoicePdf } from "./artifacts.js";

type DeliveryOutcome = Omit<Extract<Awaited<ReturnType<InvoiceDeliveryPort["send"]>>, { kind: "provider_accepted" }>, "proof">
  | Exclude<Awaited<ReturnType<InvoiceDeliveryPort["send"]>>, { kind: "provider_accepted" }>;

/** Donor sequencing over host claims, original keys, M04 transport and fenced
 * finalizers. Native hosts MUST bind terminalFailure before leasing work.
 * With CTL-M09-3's 191000 pin, failedBeforeSend settles failed_before_send with
 * evidence { phase: 'before_send', retrySeconds }: whole seconds clamped
 * to 60..86400, absent/invalid uses 900;
 * terminalFailure uses { phase: 'before_send', retryable: false } for no reclaim.
 * Native store mode refuses before claim unless its host projection is bound.
 * @consumer Host delivery facade and explicit native M04 binding.
 */
type DeliveryJobInput<Claim, Result extends DeliveryOutcome> = {
  enabled: boolean;
  providerEnabled: boolean;
  deliveryEnabled: boolean;
  claim(): Promise<readonly Claim[] | InvoiceUnsupported>;
  attemptCount(claim: Claim): number;
  validate(claim: Claim): void;
  download(claim: Claim): Promise<{ content: Uint8Array; contentType: string }>;
  filename(claim: Claim): string;
  /** A rejected promise proves failure BEFORE transport entry. Once entered,
   * the M04 binding must return uncertain, including timeout/lost ACK. */
  send(claim: Claim, document: { filename: string; content: Uint8Array; contentType: string }): Promise<Result>;
  failedBeforeSend(claim: Claim, error: unknown, retrySeconds: number): Promise<unknown>;
  /** Must durably stop reclaim using the same fence. Native failed_before_send
   * evidence { phase: 'before_send', retryable: false } sets available_at to infinity. */
  terminalFailure(claim: Claim, result: Extract<Result, { kind: "failed_before_send" | "unsupported" }>): Promise<unknown>;
  uncertain(claim: Claim, result: Extract<Result, { kind: "uncertain" }>): Promise<unknown>;
  accepted(claim: Claim, result: Extract<Result, { kind: "provider_accepted" }>): Promise<unknown>;
  finalizeUncertain(claim: Claim, receiptRef: string): Promise<unknown>;
};
type NativeClaim = Exclude<Awaited<ReturnType<InvoiceStorePort["claimDeliveries"]>>, InvoiceUnsupported>[number];
type NativeDeliveryJobInput = {
  enabled: boolean;
  providerEnabled: boolean;
  deliveryEnabled: boolean;
  store: Pick<InvoiceStorePort, "claimDeliveries" | "settleDelivery">;
  claimOptions: Parameters<InvoiceStorePort["claimDeliveries"]>[0];
  download(claim: NativeClaim): Promise<{ content: Uint8Array; contentType: string }>;
  filename(claim: NativeClaim): string;
  send: InvoiceDeliveryPort["send"];
};
/** Host callback mode preserves donor sequencing. Native store mode supplies
 * fenced terminal/backoff finalizers and the M04 envelope from claimDeliveries.
 * @consumer Host delivery facade and explicit native M04 binding.
 */
export function runInvoiceDeliveryJob(input: NativeDeliveryJobInput): ReturnType<typeof runDeliveryJob>;
export function runInvoiceDeliveryJob<Claim, Result extends DeliveryOutcome>(input: DeliveryJobInput<Claim, Result>): ReturnType<typeof runDeliveryJob>;
export function runInvoiceDeliveryJob<Claim, Result extends DeliveryOutcome>(input: NativeDeliveryJobInput | DeliveryJobInput<Claim, Result>): ReturnType<typeof runDeliveryJob> {
  if (!("store" in input)) return runDeliveryJob(input);
  const settle = async (claim: NativeClaim, result: Parameters<InvoiceStorePort["settleDelivery"]>[0]["result"], retrySeconds = 900) => {
    const outcome = await input.store.settleDelivery({ deliveryRef: claim.delivery.deliveryRef, token: claim.token,
      generation: claim.generation, providerDocumentRef: claim.providerDocumentRef, retrySeconds, result });
    if (outcome.kind !== "recorded") throw new Error("invoicing_delivery_fence");
  };
  return runDeliveryJob<NativeClaim, Awaited<ReturnType<InvoiceDeliveryPort["send"]>>>({
    enabled: input.enabled, providerEnabled: input.providerEnabled, deliveryEnabled: input.deliveryEnabled,
    claim: () => input.store.claimDeliveries(input.claimOptions), attemptCount: claim => claim.generation,
    validate: () => {}, download: input.download, filename: input.filename,
    send: (claim, document) => input.send({ ...claim.delivery, ...document }),
    failedBeforeSend: (claim, _error, retrySeconds) => settle(claim, { kind: "failed_before_send", retryable: true, code: "retryable" }, retrySeconds),
    terminalFailure: (claim, result) => settle(claim, result.kind === "failed_before_send" ? result
      : { kind: "failed_before_send", retryable: false, code: "retryable" }),
    uncertain: (claim, result) => settle(claim, result), accepted: (claim, result) => settle(claim, result),
    finalizeUncertain: (claim, receiptRef) => settle(claim, { kind: "uncertain", code: "uncertain_delivery", receiptRef }),
  });
}
async function runDeliveryJob<Claim, Result extends DeliveryOutcome>(input: DeliveryJobInput<Claim, Result>) {
  if (!input.enabled) return skipped("provider_email_disabled");
  if (!input.providerEnabled) return skipped("provider_disabled");
  if (!input.deliveryEnabled) return skipped("email_delivery_provider_disabled");
  // JS hosts missing a mandatory terminal policy must refuse before claiming.
  if (typeof input.terminalFailure !== "function") return skipped("host_binding_required");
  const claims = await input.claim();
  if (!Array.isArray(claims)) return skipped("host_binding_required");
  let updated = 0;
  let failures = 0;
  for (const claim of claims as readonly Claim[]) {
    let result: Result;
    const retrySeconds = Math.min(3600, 300 * Math.max(1, input.attemptCount(claim)));
    try {
      input.validate(claim);
      const pdf = await input.download(claim);
      assertInvoicePdf(pdf);
      result = await input.send(claim, { ...pdf, filename: input.filename(claim) });
    } catch (error) {
      failures += 1;
      await input.failedBeforeSend(claim, error, retrySeconds);
      continue;
    }
    if (result.kind === "failed_before_send" || result.kind === "unsupported") {
      failures += 1;
      if (result.kind === "failed_before_send" && result.retryable) {
        await input.failedBeforeSend(claim, result, retrySeconds);
      } else {
        await input.terminalFailure(claim, result as Extract<Result, { kind: "failed_before_send" | "unsupported" }>);
      }
      continue;
    }
    if (result.kind === "uncertain") {
      failures += 1;
      await input.uncertain(claim, result as Extract<Result, { kind: "uncertain" }>);
      continue;
    }
    try {
      await input.accepted(claim, result as Extract<Result, { kind: "provider_accepted" }>);
      updated += 1;
    } catch {
      failures += 1;
      // Acceptance plus a lost local ACK cannot become a retryable send.
      await input.finalizeUncertain(claim, result.receiptRef).catch(() => undefined);
    }
  }
  return { ok: failures === 0, checked: claims.length, updated, skipped: false, failures };
}
function skipped(reason: string) { return { ok: true, checked: 0, updated: 0, skipped: true, reason, failures: 0 }; }

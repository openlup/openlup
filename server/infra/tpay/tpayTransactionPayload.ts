export interface TpayPayerInput {
  email: string;
  name: string;
  ip?: string | null;
  userAgent?: string | null;
}

/**
 * BLIK alias sent on transaction create.
 *
 * `UID` is merchant-scoped one-click; `PAYID` is the recurring mandate.
 * `recommendedAuthLevel` is a SIBLING of `autopayment`, not a field inside it
 * (Tpay SDK `Model/Objects/Transactions/Alias.php`), and Tpay documents it as
 * available and required only for autopayment model `O`, where it omits the
 * per-charge authorization screen.
 */
export interface TpayAliasInput {
  value: string;
  type: "UID" | "PAYID";
  label?: string;
  recommendedAuthLevel?: "NOCONFREQ";
  /**
   * Collect immediately instead of giving the payer 72 hours to approve. Required
   * on every model `O` charge; available for models `A` and `O` only.
   */
  noDelay?: boolean;
  /**
   * `frequency` is deliberately absent: Tpay requires it for model `A`, treats it
   * as optional for `M`, and does not accept it for `O`. We only ever register
   * variable-amount mandates, so no caller needs it.
   */
  autopayment?: { model: "A" | "M" | "O" };
}

export interface TpayTransactionCreateInput {
  amount: number;
  currency: "PLN";
  description: string;
  hiddenDescription: string;
  payer: TpayPayerInput;
  notificationUrl: string;
  successUrl: string;
  errorUrl: string;
  groupId?: number;
  channelId?: string;
  blikPaymentType?: 2;
  blikToken?: string;
  /**
   * Ask BLIK to reject the transaction outright when the payer's bank does not
   * support recurring payments, instead of taking the money and silently never
   * showing the mandate invitation. Only meaningful when registering a `PAYID`
   * alias; never set it for a plain one-off BLIK payment.
   */
  refuseNoPayId?: boolean;
  alias?: TpayAliasInput | null;
  simulatorContext?: {
    orderId?: string;
    paymentIntentId: string;
    clientId?: string;
    /** Stable per provider attempt; simulator-only and never sent to Tpay. */
    providerAttemptKey?: string;
    /**
     * In-account terminal path the simulator panel returns to after the buyer
     * settles (account `returnContext` only). Absent for the public flow, which
     * keeps the simulator page's own `/skomponuj-pakiet/platnosc` return so the
     * public path stays byte-identical (and client-side localized).
     */
    returnPath?: string;
  };
}

/** One entry of Tpay's `payments.errors[]`. `errorCode` is low-cardinality. */
export interface TpayPaymentError {
  errorCode: string;
  errorMessage: string;
  fieldName: string | null;
}

/**
 * Create-transaction result.
 *
 * ⚠️ Tpay signals a synchronous BLIK rejection ONLY through `payments.errors[]`
 * and the absence of `payments.payIdEligible`. Verified against production
 * 2026-07-20: a rejected recurring BLIK still returns HTTP 200 with
 * `result: "success"`, top-level `status: "pending"` AND `payments.status:
 * "pending"`. Those three fields therefore prove nothing — never branch on them
 * to decide success. `payments.method` is equally useless: it reads
 * `"pay_by_link"` even for a settled BLIK PayID charge.
 *
 * This matters because Tpay has no async channel for failures — the transaction
 * webhook's `tr_status` only ever carries `true` or `chargeback`, so a decline
 * that is not read out of this response is never reported at all.
 */
export interface TpayTransactionCreated {
  transactionId: string;
  title: string;
  status: string;
  transactionPaymentUrl: string | null;
  requestId: string | null;
  /**
   * Whether BLIK considers the payer's bank capable of registering a PayID
   * mandate. Present and `true` when eligible; absent entirely when Tpay
   * rejected the transaction.
   *
   * ⚠️ UNDOCUMENTED — observed empirically, absent from Tpay's OpenAPI spec and
   * from their official SDK. Treat as a hint that may vanish without notice and
   * always keep `errors` as the fallback signal.
   */
  payIdEligible: boolean | null;
  /** Synchronous provider errors. Empty when the request was accepted. */
  errors: TpayPaymentError[];
}

/**
 * Per-field maxima Tpay enforces on `payer.*`, read from the provider's own SDK
 * rather than inferred. In `tpay-com/tpay-openapi-php`,
 * `src/Model/Objects/Transactions/Payer.php` binds every accepted wire key to a
 * field model, and each model declares the `$maxLength` the API applies:
 *
 *   email      `src/Model/Fields/Person/Email.php`      255
 *   name       `src/Model/Fields/Payer/Name.php`        255
 *   ip         `src/Model/Fields/Payer/IP.php`          255
 *   userAgent  `src/Model/Fields/Payer/UserAgent.php`   255
 *
 * ⚠️ The unit is BYTES, not characters: `src/Model/Fields/FieldValidator.php`
 * measures with PHP `strlen()`, which counts bytes. A 255-CHARACTER name in an
 * accented or non-Latin script can be far more than 255 bytes in UTF-8 and would
 * still be refused, so the clamp below counts bytes.
 *
 * An over-long field is refused synchronously with HTTP 400 `not_valid`. On BLIK
 * the code then never reaches the bank and the buyer sees no prompt at all: the
 * Facebook iOS in-app WebView user agent is 271 characters, which cost four
 * orders and two cancelled subscriptions from 2026-08-28. Ledger:
 * `docs/archive/incidents/prod-tpay-payer-useragent-255-2026-08-28.md`.
 */
const TPAY_PAYER_MAX_BYTES = {
  email: 255,
  name: 255,
  ip: 255,
  userAgent: 255,
} as const;

/**
 * Fits one payer field inside the provider's documented maximum.
 *
 * ⛔ Truncate, never omit, and for every one of the four keys. `Field.php` runs
 * a `pattern` check only for models that declare one and none of these four
 * does, so a truncated value stays structurally valid; `getRequiredFields()`
 * makes `email` and `name` mandatory, so dropping either only buys a different
 * 400; and `ts:request:no_ip` is a real provider error, so dropping `ip` trades
 * one refusal for another. Truncation also keeps the prefix that a fraud review
 * or a support ticket can still read.
 *
 * Lives here, in the single function that serialises the wire body, so no payer
 * producer can bypass it.
 */
function payerFieldWithinLimit(key: keyof typeof TPAY_PAYER_MAX_BYTES, value: string): string {
  const maxBytes = TPAY_PAYER_MAX_BYTES[key];
  const bytes = new TextEncoder().encode(value);
  if (bytes.length <= maxBytes) return value;
  let end = maxBytes;
  // Never cut inside a code point: UTF-8 continuation bytes are 0b10xxxxxx, so
  // walk back off them rather than emitting a replacement character.
  while (end > 0 && (bytes[end] & 0xc0) === 0x80) end -= 1;
  return new TextDecoder().decode(bytes.subarray(0, end));
}

/**
 * Builds the `POST /transactions` wire payload.
 *
 * Every BLIK-specific field lives under `pay.blikPaymentData`; `aliases` carries
 * the mandate. `refuseNoPayId` sits beside `aliases` (not inside it), while
 * `recommendedAuthLevel` and `noDelay` sit inside the alias object as siblings of
 * `autopayment` — matching Tpay's SDK object model and verified against
 * production on 2026-07-20.
 */
export function buildTpayTransactionPayload(input: TpayTransactionCreateInput): Record<string, unknown> {
  const pay: Record<string, unknown> = {};
  if (input.groupId) pay.groupId = input.groupId;
  if (input.channelId) pay.channelId = input.channelId;
  if (input.blikToken || input.alias) {
    pay.blikPaymentData = {
      ...(input.blikPaymentType ? { type: input.blikPaymentType } : {}),
      ...(input.blikToken ? { blikToken: input.blikToken } : {}),
      ...(input.refuseNoPayId ? { refuseNoPayId: true } : {}),
      ...(input.alias ? { aliases: input.alias } : {}),
    };
  }
  return {
    amount: input.amount,
    currency: input.currency,
    description: input.description,
    hiddenDescription: input.hiddenDescription,
    payer: {
      email: payerFieldWithinLimit("email", input.payer.email),
      name: payerFieldWithinLimit("name", input.payer.name),
      ...(input.payer.ip ? { ip: payerFieldWithinLimit("ip", input.payer.ip) } : {}),
      ...(input.payer.userAgent
        ? { userAgent: payerFieldWithinLimit("userAgent", input.payer.userAgent) }
        : {}),
    },
    ...(Object.keys(pay).length > 0 ? { pay } : {}),
    callbacks: {
      notification: { url: input.notificationUrl },
      payerUrls: { success: input.successUrl, error: input.errorUrl },
    },
  };
}

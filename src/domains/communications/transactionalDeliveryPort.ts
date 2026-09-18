/** Narrow, portable receipt contract for the captured transactional action. */

const IDENTIFIER = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/;

/** Bounded opaque identifiers keep commands and persisted evidence content-free. */
export function isTransactionalDeliveryIdentifier(value: string): boolean {
  return IDENTIFIER.test(value);
}

export interface TransactionalDeliveryCommand {
  readonly idempotencyKey: string;
  /** Opaque recipient reference; never persisted outside the command fingerprint. */
  readonly recipientReference: string;
  /** Opaque template reference; never persisted outside the command fingerprint. */
  readonly templateReference: string;
  /** Optional bounded reference to an expiring/revocable access grant. */
  readonly accessGrantReference?: string;
}

export type TransactionalDeliveryReceipt = {
  readonly idempotencyKey: string;
  readonly commandFingerprint: string;
  readonly state: "accepted";
  readonly deliveryReference: string;
  readonly errorCode: null;
  readonly attemptCount: number;
} | {
  readonly idempotencyKey: string;
  readonly commandFingerprint: string;
  readonly state: "failed";
  readonly deliveryReference: null;
  readonly errorCode: string;
  readonly attemptCount: number;
};

export interface TransactionalDeliveryReceiptStore {
  readReceipt(idempotencyKey: string): Promise<TransactionalDeliveryReceipt | null>;
  recordAccepted(input: {
    idempotencyKey: string;
    commandFingerprint: string;
    deliveryReference: string;
  }): Promise<TransactionalDeliveryReceipt>;
  recordFailed(input: {
    idempotencyKey: string;
    commandFingerprint: string;
    errorCode: string;
  }): Promise<TransactionalDeliveryReceipt>;
}

export interface CapturedTransactionalDeliveryPort {
  deliver(command: TransactionalDeliveryCommand): Promise<{ deliveryReference: string }>;
}

export interface DeliveryPollCandidate {
  id: string;
  messageId: string;
}

export interface DeliveryStatusRead {
  ok: boolean;
  httpStatus: number;
  recipientEmail: string | null;
}

/** The host maps its protocol to an opaque event type and terminal classification. */
export interface DeliveryPollObservation {
  eventType: string;
  terminal: boolean;
}

export interface DeliveryReconciliationPort {
  findFrozenSends(input: { now: string; graceMinutes: number; limit: number }): Promise<DeliveryPollCandidate[]>;
  applyPolledEvent(input: {
    sendId: string;
    messageId: string;
    eventType: string;
    eventAt: string;
    recipientEmail: string | null;
  }): Promise<void>;
  recordPollAttempt(input: { sendId: string; attemptedAt: string }): Promise<void>;
  recordSendNotFound(input: { sendId: string; threshold: number }): Promise<{ abandoned: boolean }>;
}

export const DELIVERY_POLL_ABANDON_AFTER_NOT_FOUND = 3;

export interface DeliveryReadFailureBreakdown {
  notFound: number;
  authFailed: number;
  network: number;
  providerError: number;
  other: number;
}

export interface DeliveryReconciliationResult {
  checked: number;
  reconciled: number;
  stillPending: number;
  terminalPolled: number;
  failures: number;
  abandoned: number;
  failureBreakdown: DeliveryReadFailureBreakdown;
}

function classifyReadFailure(breakdown: DeliveryReadFailureBreakdown, httpStatus: number): void {
  if (httpStatus === 404) breakdown.notFound += 1;
  else if (httpStatus === 401 || httpStatus === 403) breakdown.authFailed += 1;
  else if (httpStatus === 0) breakdown.network += 1;
  else if (httpStatus >= 500 && httpStatus <= 599) breakdown.providerError += 1;
  else breakdown.other += 1;
}

/** Sequential bounded polling around one host-owned atomic convergence writer. */
export async function runDeliveryReconciliation<Read extends DeliveryStatusRead>(input: {
  port: DeliveryReconciliationPort;
  readEmail: (messageId: string) => Promise<Read>;
  observationFor: (read: Read) => DeliveryPollObservation | null;
  now: string;
  graceMinutes: number;
  limit: number;
}): Promise<DeliveryReconciliationResult> {
  const result: DeliveryReconciliationResult = {
    checked: 0, reconciled: 0, stillPending: 0, terminalPolled: 0, failures: 0, abandoned: 0,
    failureBreakdown: { notFound: 0, authFailed: 0, network: 0, providerError: 0, other: 0 },
  };
  const frozen = await input.port.findFrozenSends({ now: input.now, graceMinutes: input.graceMinutes, limit: input.limit });
  for (const send of frozen) {
    result.checked += 1;
    const read = await input.readEmail(send.messageId);
    if (read.httpStatus !== 404) {
      try {
        await input.port.recordPollAttempt({ sendId: send.id, attemptedAt: input.now });
      } catch {
        // Fairness bookkeeping failure must not discard observed delivery truth.
        result.failures += 1;
      }
    }
    if (!read.ok) {
      result.failures += 1;
      classifyReadFailure(result.failureBreakdown, read.httpStatus);
      if (read.httpStatus === 404) {
        const { abandoned } = await input.port.recordSendNotFound({ sendId: send.id, threshold: DELIVERY_POLL_ABANDON_AFTER_NOT_FOUND });
        if (abandoned) result.abandoned += 1;
      }
      continue;
    }
    const observation = input.observationFor(read);
    if (!observation) {
      result.stillPending += 1;
      continue;
    }
    try {
      await input.port.applyPolledEvent({ sendId: send.id, messageId: send.messageId,
        eventType: observation.eventType, eventAt: input.now, recipientEmail: read.recipientEmail });
      result.reconciled += 1;
      if (observation.terminal) result.terminalPolled += 1;
    } catch {
      result.failures += 1;
    }
  }
  return result;
}

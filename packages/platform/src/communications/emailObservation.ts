/** An authenticated, decoded, environment-admitted observation. Evidence is opaque. */
export interface EmailObservation {
  eventType: string;
  eventAt: string;
  metadata: Record<string, unknown>;
}

export interface EmailObservationPort {
  findSend(messageId: string): Promise<{ id: string } | null>;
  applyObservation(observation: EmailObservation & { sendId: string; messageId: string }): Promise<void>;
  recordAttempt(attempt: EmailObservationDisposition): Promise<void>;
}

export type EmailObservationDisposition =
  | { outcome: "send_not_found" }
  | { outcome: "processed"; sendId: string };

/** Lookup/apply failures propagate; attempt telemetry cannot overturn authoritative success. */
export async function processEmailObservation(input: {
  port: EmailObservationPort;
  messageId: string;
  // Construct evidence only after a local send is found (including clock reads).
  observation: () => EmailObservation;
}): Promise<EmailObservationDisposition> {
  const send = await input.port.findSend(input.messageId);
  let disposition: EmailObservationDisposition;
  if (!send) {
    disposition = { outcome: "send_not_found" };
  } else {
    await input.port.applyObservation({
      sendId: send.id,
      messageId: input.messageId,
      ...input.observation(),
    });
    disposition = { outcome: "processed", sendId: send.id };
  }
  try {
    await input.port.recordAttempt(disposition);
  } catch {
    // Best-effort telemetry is separate from durable convergence.
  }
  return disposition;
}

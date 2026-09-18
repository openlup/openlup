import { createHash } from "node:crypto";

/**
 * The sealed transport boundary for handing an accounting document to its recipient.
 *
 * The kernel exercises the whole capability up to this line: a document is owed, registered with
 * whatever authority the market has, queued, claimed and settled against a receipt. What crosses
 * the line is one opaque hand-off, and this adapter is the deliberately inert implementation of
 * it -- deterministic, and leaving the installation by no route at all.
 *
 * It is FAIL CLOSED, and that is the whole design. An installation that has declared no delivery
 * channel gets a refusal, never a silent success: a boundary whose default answer is "fine" is
 * how a deployment discovers months later that nothing was ever handed to anyone.
 */
export type CapturedDocumentDeliveryCommand = {
  readonly deliveryId: string;
  readonly recipientReference: string;
};

export type CapturedDocumentDeliveryPort = {
  deliver(command: CapturedDocumentDeliveryCommand): Promise<{ readonly receiptReference: string }>;
};

export type CapturedDocumentDeliveryResolution =
  | { readonly port: CapturedDocumentDeliveryPort; readonly refused?: undefined }
  | { readonly port?: undefined; readonly refused: string };

/** The one marker that opens the boundary. Anything else, including its absence, is a refusal. */
export const CAPTURED_DOCUMENT_DELIVERY_CHANNEL = "captured";
const CHANNEL_KEY = "PLATFORM_DOCUMENT_DELIVERY_CHANNEL";

const reference = (command: CapturedDocumentDeliveryCommand): string =>
  `captured:${createHash("sha256")
    .update(`${command.deliveryId}::${command.recipientReference}`)
    .digest("hex")
    .slice(0, 32)}`;

/**
 * Resolve the boundary for one installation. The environment is the only input, and every path
 * that is not an explicit declaration of the captured channel ends in a named refusal.
 */
export function resolveCapturedDocumentDelivery(
  env: Record<string, string | undefined>,
): CapturedDocumentDeliveryResolution {
  const declared = env[CHANNEL_KEY]?.trim().toLowerCase() ?? "";
  if (declared === "") return { refused: "document_delivery_channel_undeclared" };
  if (declared !== CAPTURED_DOCUMENT_DELIVERY_CHANNEL) {
    return { refused: "document_delivery_channel_unsupported" };
  }
  return {
    port: {
      async deliver(command) {
        if (typeof command.deliveryId !== "string" || command.deliveryId.trim() === "") {
          throw new Error("document_delivery_command_invalid");
        }
        if (typeof command.recipientReference !== "string" || command.recipientReference.trim() === "") {
          throw new Error("document_delivery_recipient_missing");
        }
        return { receiptReference: reference(command) };
      },
    },
  };
}

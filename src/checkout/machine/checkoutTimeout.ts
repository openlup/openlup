import { BffClientError } from "@/lib/bff/client";

/**
 * `requestBff` aborts a timed-out submit and throws
 * `UPSTREAM_UNAVAILABLE` / `reason: "timeout"`. This is a TRANSIENT network stall
 * (a hung mobile connection), not a hard checkout failure — surface a distinct
 * "try again" message and let the buyer retry on the same stable journey key
 * (which resumes/updates the same order rather than minting a duplicate).
 */
export function isCheckoutTimeoutError(error: unknown): boolean {
  if (!(error instanceof BffClientError)) return false;
  if (error.code !== "UPSTREAM_UNAVAILABLE") return false;
  const details = error.details;
  return (
    typeof details === "object" &&
    details !== null &&
    "reason" in details &&
    details.reason === "timeout"
  );
}

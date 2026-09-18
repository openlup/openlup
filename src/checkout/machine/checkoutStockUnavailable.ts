import { BffClientError } from "@/lib/bff/client";

export function isStockUnavailableCheckoutError(error: unknown): boolean {
  if (!(error instanceof BffClientError)) return false;
  if (error.code !== "CONFLICT") return false;
  const details = error.details;
  return (
    typeof details === "object" &&
    details !== null &&
    "reason" in details &&
    details.reason === "stock_unavailable"
  );
}

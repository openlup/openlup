import { execFileSync } from "node:child_process";
import { writeFileSync } from "node:fs";
import { join } from "node:path";
import { isolatedConsumerEnv } from "./pack-manifest-input.ts";

export const paymentSubpath = "@openlup/platform/payments";
export const paymentSymbol = "terminalAmountMismatch";

// Released successful readback without capturedAmountBasis. The same input
// must keep its terminal outcome whether the release accepts or refuses it.
export function paymentOutcome(directory: string): string {
  const script = join(directory, "released-payment.mjs");
  writeFileSync(script, `
import { ${paymentSymbol} } from ${JSON.stringify(paymentSubpath)};
const attempt = { amountMinor: 100, currency: "USD" };
const readback = { status: "succeeded", amountMinor: 100, currency: "USD" };
process.stdout.write(JSON.stringify(${paymentSymbol}(attempt, readback)));
`);
  return execFileSync(process.execPath, [script], {
    cwd: directory, env: isolatedConsumerEnv(), encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 10_000,
  });
}

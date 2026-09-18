/**
 * Tells a server process what it settles in, once, before it parses any money.
 *
 * `src/lib/currency/platformCurrency.ts` resolves its ambient settlement profile
 * from the record a bundler substitutes. A plain server process has no such
 * record, so without this call the ambient currency schema — which every money
 * node of every contract is built on — answers for the platform default and
 * refuses whatever the deployment is actually configured to settle in.
 *
 * The reading half cannot live in `src/`: `scripts/check-client-secret-boundary.ts`
 * forbids naming the process environment there, because those files are bundled
 * into the browser. That prohibition is the whole reason an explicit
 * initialisation exists rather than a fallback inside the currency module. This
 * file is the one line that crosses the boundary, in the direction that is safe.
 *
 * Composition roots call it as their first act. It is idempotent for a process
 * reading one environment, and throws if a process is ever told two different
 * things, so calling it from more than one root in the same process is
 * deliberate rather than merely tolerated.
 */
import {
  initAmbientSettlementProfile,
  readSettlementProfile,
} from "../../src/lib/currency/platformCurrency.js";

export function bootstrapAmbientSettlementProfile(
  env: Readonly<Record<string, string | undefined>> = process.env,
): void {
  initAmbientSettlementProfile(readSettlementProfile(env));
}

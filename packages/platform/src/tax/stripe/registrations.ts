import { checked } from "../contracts/decode.js";
import { cellKey, declarationKey, includesInstant } from "../contracts/identity.js";
import type { TaxCoverageInputV1, TaxQuoteInputV1 } from "../contracts/index.js";
import { taxDigest } from "../digest.js";
import { checkScope, incomplete, member, providerDecode, readPages, record, registration, text } from "./client.js";
import type { StripeQuoteClient } from "./client.js";
import type { StripeQuoteMarketPack } from "./plan.js";

type Observation = TaxCoverageInputV1["observations"][number];
const knownTypes = new Set([
  "state_sales_tax", "state_retail_delivery_fee", "state_communications_tax", "local_amusement_tax",
  "local_lease_tax", "mass_transit_parking_tax", "parking_tax",
]);
const regionCode = providerDecode(checked((value): value is string => typeof value === "string" && /^[A-Z]{2}$/u.test(value),
  "Obtain the two-letter uppercase provider region code."));

// Point evidence bounds an observation without projecting the current inventory or rate into the future.
export const witnessedInstant = (date: string) => ({ from: date, until: new Date(Date.parse(date) + 1).toISOString() });

export async function readRegistrations(client: StripeQuoteClient, input: TaxQuoteInputV1, pack: StripeQuoteMarketPack) {
  const countries = new Set(pack.registrations.map(binding => binding.country));
  const rows = await readPages("/v1/tax/registrations", "/registrations", input.scope,
    page => client.registrations.list({ ...page, status: "all" }), (value, path) => {
      checkScope(record(value, path), path, input.scope, true);
      const row = registration(value, path);
      regionCode(row.country, path + "/country");
      const effective = { from: row.active_from, ...(row.expires_at !== null && { until: row.expires_at }) };
      if (effective.until !== undefined && effective.until <= effective.from) {
        incomplete(path + "/expires_at", "The provider registration interval is reversed.");
      }
      if (!countries.has(row.country)) return { id: row.id, country: row.country, effective };
      const key = row.country.toLowerCase();
      const field = path + "/country_options/" + key;
      const details = record(member(row.country_options, key, field), field);
      return { id: row.id, country: row.country, effective,
        state: regionCode(member(details, "state", field + "/state"), field + "/state"),
        type: text(member(details, "type", field + "/type"), field + "/type") };
    });

  const observations = new Map<string, Observation["registration"]>();
  for (const cell of input.required) {
    const key = cellKey(cell);
    const type = cell.target.kind === "fee" ? "state_retail_delivery_fee" : "state_sales_tax";
    const bindings = pack.registrations.filter(binding => declarationKey(binding) === declarationKey(cell) && binding.type === type);
    if (bindings.length !== 1) continue;
    const [binding] = bindings;
    const region = rows.filter(row => row.country === binding.country && row.state === binding.state);
    const matching = region.filter(row => row.type === binding.type);
    const active = matching.filter(row => includesInstant(row.effective, input.taxDate));
    if (active.length === 1) {
      const [row] = active;
      observations.set(key, { state: "active", effective: row.effective, evidenceRef: row.id });
    } else if (active.length === 0 && binding.complete && region.every(row => knownTypes.has(row.type ?? ""))) {
      const evidenceRef = taxDigest("coverage", [input.scope, binding, matching.sort((a, b) => a.id < b.id ? -1 : 1)]);
      observations.set(key, { state: "inactive", effective: witnessedInstant(input.taxDate), evidenceRef });
    }
  }
  return observations;
}

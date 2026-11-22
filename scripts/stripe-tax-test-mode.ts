import { randomUUID } from "node:crypto";
import { argv, env } from "node:process";
import { createStripeTaxClient } from "../server/infra/stripe/stripeTaxClient.js";

// Invoke with node --import tsx scripts/stripe-tax-test-mode.ts --run --test-mode.
async function qualify() {
  if (argv.length !== 4 || !argv.includes("--run") || !argv.includes("--test-mode")) {
    throw new Error("Supply both --run and --test-mode.");
  }
  if (env.CI) throw new Error("Run this qualification interactively outside CI.");
  const { STRIPE_SECRET_KEY: secretKey, STRIPE_TAX_ACCOUNT: accountRef } = env;
  if (!secretKey?.startsWith("sk_test_") || !accountRef) throw new Error("Supply a test credential and its expected account.");
  const client = await createStripeTaxClient({ secretKey, scope: { accountRef, mode: "test" } });
  const address = { line1: "200 E Colfax Ave", city: "Denver", state: "CO", postal_code: "80203", country: "US" };
  const prefix = "ol-tax-test-" + randomUUID();
  const tax_date = Math.floor(Date.now() / 1000);
  const calculation = await client.calculations.create({
    currency: "usd", tax_date, expand: ["shipping_cost.tax_breakdown"],
    customer_details: { address, address_source: "shipping" }, ship_from_details: { address },
    shipping_cost: { amount: 0, tax_code: "txcd_92010001", tax_behavior: "exclusive" },
    line_items: [{ reference: "synthetic-item", amount: 1000, quantity: 1, tax_code: "txcd_99999999",
      tax_behavior: "exclusive", metadata: {} }],
  }, { idempotencyKey: prefix + "-calculation" });
  if (!calculation.id || calculation.livemode !== false || calculation.currency !== "usd" || calculation.tax_date !== tax_date) {
    throw new Error("The calculation does not have the expected test binding.");
  }
  const lines = await client.calculations.listLineItems(calculation.id, { limit: 100, expand: ["data.tax_breakdown"] });
  if (lines.has_more || lines.data.length !== 1 || lines.data[0].livemode !== false) throw new Error("The test line evidence is incomplete.");
  const fee = calculation.tax_breakdown.some(row => row.tax_rate_details.tax_type === "retail_delivery_fee");
  console.log(JSON.stringify({ calculation: "verified_test", expandedLines: Array.isArray(lines.data[0].tax_breakdown), feeObserved: fee }));
  if (fee) return; // Fee reporting requires independent qualification.
  const sale = await client.transactions.createFromCalculation({
    calculation: calculation.id, reference: prefix + "-sale", posted_at: tax_date,
    metadata: { openlup_request_digest: prefix },
  }, { idempotencyKey: prefix + "-commit" });
  if (sale.livemode !== false || sale.type !== "transaction" || sale.reference !== prefix + "-sale") throw new Error("Test sale mismatch.");
  const posted = await client.transactions.listLineItems(sale.id, { limit: 100 });
  const line = posted.data[0];
  if (posted.has_more || posted.data.length !== 1 || line.livemode !== false || line.amount !== lines.data[0].amount
    || line.amount_tax !== lines.data[0].amount_tax || line.reference !== "synthetic-item") {
    throw new Error("Test sale line mismatch.");
  }
  const reversal = await client.transactions.createReversal({
    original_transaction: sale.id, mode: "full", reference: prefix + "-refund", metadata: { openlup_request_digest: prefix },
  }, { idempotencyKey: prefix + "-reverse" });
  const recovered = await client.transactions.retrieve(reversal.id);
  if (recovered.livemode !== false || recovered.type !== "reversal" || recovered.reference !== prefix + "-refund"
    || recovered.reversal?.original_transaction !== sale.id) throw new Error("Test reversal mismatch.");
  const reversed = await client.transactions.listLineItems(recovered.id, { limit: 100 });
  const reverseLine = reversed.data[0];
  if (reversed.has_more || reversed.data.length !== 1 || reverseLine.livemode !== false
    || reverseLine.reversal?.original_line_item !== line.id || reverseLine.amount !== -line.amount
    || reverseLine.amount_tax !== -line.amount_tax) throw new Error("Test reversal line mismatch.");
  console.log(JSON.stringify({ posting: "verified_test", reversal: "verified_test", retrieval: "verified_test" }));
}

qualify().catch(() => {
  console.error("Tax qualification stopped. Supply the explicit test flags and test account, then inspect the test dashboard for any reporting effect before repeating.");
  process.exitCode = 1;
});

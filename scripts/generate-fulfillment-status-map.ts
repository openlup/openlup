// Regenerates config/fulfillment-status-map.json from the runtime source of truth
// (src/domains/fulfillment/statusMap.ts). Run after editing the map:
//   npx tsx scripts/generate-fulfillment-status-map.ts
// statusMap.test.ts fails if the committed JSON drifts from the TS const, so the
// two never diverge. See docs/FULFILLMENT_STATUS_CANON.md.
import { writeFileSync } from "node:fs";
import { join } from "node:path";

import { FULFILLMENT_STATUS_MAP } from "../src/domains/fulfillment/statusMap";

const target = join(process.cwd(), "config/fulfillment-status-map.json");
writeFileSync(target, `${JSON.stringify(FULFILLMENT_STATUS_MAP, null, 2)}\n`, "utf8");
console.log(`Wrote ${target}`);

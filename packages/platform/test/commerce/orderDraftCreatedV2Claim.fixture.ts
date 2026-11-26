import { readFileSync } from "node:fs";
import { readCommerceOrderDraftCreatedV2Event } from "../../src/commerce/server/orderDraftCreatedV2Event.js";

const claimed: unknown = JSON.parse(readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify(readCommerceOrderDraftCreatedV2Event(claimed)));

import { readFileSync } from "node:fs";
import { readPaidOrderMoneyV2 } from "../../src/commerce/server/paidOrderMoneyV2.js";

const { id, result } = JSON.parse(readFileSync(0, "utf8")) as { id: string; result: unknown };
const money = await readPaidOrderMoneyV2({ query: async () => ({ rows: [{ value: result }] }) }, id);
process.stdout.write(JSON.stringify(money));

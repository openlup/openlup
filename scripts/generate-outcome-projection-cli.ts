/** Source-checkout wrapper; executable admission is owned by the publication contract. */
import { resolve } from "node:path";
import { runOutcomeProjection } from "./generate-outcome-projection.ts";

runOutcomeProjection(resolve(import.meta.dirname, ".."), process.argv.slice(2));

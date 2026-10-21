import { readFileSync } from "node:fs";
// Relocated donor witness: read the actual reference detector's literal without
// importing application implementation into the package module graph.
const source = readFileSync(new URL("../../../../../server/domains/platform/checkoutAbandonmentEvidence.ts", import.meta.url), "utf8");
const match = /^export const ABANDONED_BEFORE_CONFIRMATION = "([^"]+)";$/m.exec(source);
if (!match) throw new Error("Reference detector token is missing or no longer a literal");
export const ABANDONED_BEFORE_CONFIRMATION = match[1];

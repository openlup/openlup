/** Source-checkout wrapper; emits the package-set BOM without building or publishing. */
import { resolve } from "node:path";
import { generateReleaseBom } from "./generate-release-bom.ts";

const [manifest, commit, ...extra] = process.argv.slice(2);
if (!manifest || !commit || extra.length) throw new Error("Use packages-manifest.json full-source-commit; BOM JSON is written to stdout");
console.log(JSON.stringify(generateReleaseBom(process.cwd(), resolve(manifest), commit), null, 2));

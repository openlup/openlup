import { createHash } from "node:crypto";

const digest = (contents: string): string => "sha256-" + createHash("sha256").update(contents).digest("hex");
const exact: Array<[string, string]> = [[["https://github.com/example", "app"].join("/"), "https://github.com/openlup/openlup"], [["An adopter conformance", "test"].join(" "), "Adopters SHOULD add a conformance test that"]];
const descriptor = JSON.stringify({ exact });
export const NEUTRALIZATION_RULESET_DIGEST = digest(descriptor);
export function projectOperationalCoordinates(source: string, _path = ""): { contents: string; matches: number } { let contents = source; let matches = 0; for (const [value, replacement] of exact) { const count = contents.split(value).length - 1; if (count > 0) { contents = contents.split(value).join(replacement); matches += count; } } return { contents, matches }; }
export function carriesPrivateOperationalCoordinate(contents: string, _path = ""): boolean { return exact.some(([value]) => contents.includes(value)); }

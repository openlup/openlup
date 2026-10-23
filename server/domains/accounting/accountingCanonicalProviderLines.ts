import { mapCanonicalIssueLines as mapLines } from "@openlup/platform/invoicing";
export function mapCanonicalIssueLines(lines: unknown[], gross: number, net: number) {
  return mapLines(lines, gross, net, "Product");
}

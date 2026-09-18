import { canonicalizeLegacyPublicPathname } from "./publicRoutes";

export function canonicalizeEnAliasPathname(pathname: string): string | null {
  return canonicalizeLegacyPublicPathname(pathname);
}

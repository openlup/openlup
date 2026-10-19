import type { IdentityJwtLibraryLoader } from "@openlup/platform/identity";
/** The selected host supplies its installed JWT library; package imports stay cold. */
export const loadOidcJwt: IdentityJwtLibraryLoader = () => import("jose");

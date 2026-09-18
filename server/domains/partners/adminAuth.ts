export type PartnersAdminAuthorizationResult =
  | { ok: true }
  | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN"; message: string };

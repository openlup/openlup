export type PlatformAdminAuthorizationResult =
  | { ok: true }
  | { ok: false; code: "UNAUTHORIZED" | "FORBIDDEN"; message: string };

export type PlatformUserAuthenticationResult =
  | { ok: true; userId: string }
  | { ok: false; code: "UNAUTHORIZED"; message: string };

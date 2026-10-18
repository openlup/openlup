export type CustomerUserAuthenticationResult =
  | { ok: true; userId: string }
  | { ok: false; code: "UNAUTHORIZED"; message: string };

export class PlatformControlPlaneConflictError extends Error {
  override readonly name = "PlatformControlPlaneConflictError";
}
export class PlatformControlPlaneUnavailableError extends Error {
  override readonly name = "PlatformControlPlaneUnavailableError";
}

export type PackageManifest = {
  name?: string;
  version?: string;
  workspaces?: unknown;
  dependencies?: Record<string, string>;
  exports?: Record<string, unknown>;
  scripts?: Record<string, string>;
};

export const corePackageName = "@openlup/core";
export const workspaceDependencySpec = "file:packages/core";

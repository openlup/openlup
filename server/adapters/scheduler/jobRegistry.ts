// Reference-application binding: this path keeps its importers while the implementation lives in
// @openlup/platform. It binds the reference application's single source,
// config/platform-runtime.json, as the default configuration file.

import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

import { loadJobRegistry as loadPlatformJobRegistry, type ScheduledJob } from "@openlup/platform/scheduler";

export { jobIdFromPath, jobRegistryFromConfig, type ScheduledJob } from "@openlup/platform/scheduler";

const MODULE_DIR = dirname(fileURLToPath(import.meta.url));
// server/adapters/scheduler/ -> repo root is three levels up.
const DEFAULT_CONFIG_PATH = join(MODULE_DIR, "..", "..", "..", "config", "platform-runtime.json");

/** Build the job registry from the committed single source, or an explicit config path (tests). */
export function loadJobRegistry(configPath: string = DEFAULT_CONFIG_PATH): ScheduledJob[] {
  return loadPlatformJobRegistry(configPath);
}

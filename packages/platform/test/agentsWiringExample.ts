import { createScheduledJobRegistry } from "@openlup/platform/scheduler";

export const jobs = createScheduledJobRegistry([
  { id: "app-cleanup", schedule: "0 * * * *", run: async () => {} },
]);

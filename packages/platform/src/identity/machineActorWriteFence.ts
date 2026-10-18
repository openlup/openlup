import type { HttpResponse } from "../http/index.js";
import { createIdentityResponder, type IdentityResponseOptions } from "./response.js";

export function refusesMachineActorRequest(
  route: string,
  method: string | undefined,
  isMachineActor: boolean | undefined,
  writeRoutes: readonly string[] = [],
): boolean {
  if (isMachineActor === false) return false;
  const verb = (method ?? "").toUpperCase();
  return verb !== "GET" && verb !== "HEAD" && !writeRoutes.includes(route);
}
export function sendMachineActorWriteRefused(res: HttpResponse, options: IdentityResponseOptions = {}): void {
  const { sendBffError } = createIdentityResponder(options);
  sendBffError(res, "FORBIDDEN", "Human operator required", {
    details: { reason: "machine_actor_write_refused" },
  });
}

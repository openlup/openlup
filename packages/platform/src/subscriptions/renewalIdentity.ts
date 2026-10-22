import type { RenewalIdentity, RenewalSchedule } from "./contracts/renewal.js";
/** The host's existing dialect owns every byte; no normalization or new prefix. */
export function renewalIdentity(schedule: RenewalSchedule, keys: (schedule: RenewalSchedule) => RenewalIdentity): RenewalIdentity {
  return keys(schedule);
}

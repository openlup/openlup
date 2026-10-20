import { EMAIL_CANON_REGISTRY } from "../../../src/domains/communications/emailCanon.js";
/** Executable projection of selected implemented canon rows, never a cadence or a new catalogue. */
export function bindCommunicationTriggers(input: readonly { slug: string; run: (...args: never[]) => unknown }[]) {
 const seen = new Set<string>();
 return input.map(binding=>{
  const row=EMAIL_CANON_REGISTRY.find(row=>row.slug===binding.slug);
  if(!row || row.deliveryStatus!=="implemented" || seen.has(binding.slug) || typeof binding.run!=="function") throw new Error("communication_trigger_unbound_or_inert");
  seen.add(binding.slug);
  return Object.freeze({slug:row.slug,owner:row.owner,triggerEvent:row.triggerEvent,mechanism:row.mechanism,run:binding.run});
 });
}

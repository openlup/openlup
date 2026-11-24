/** @internal The company and regional prefixes for 13-digit restricted-circulation numbers. */
export function isRestrictedCirculationNumber(value: string): boolean {
  return /^(?:0[24]|2[0-9])[0-9]{11}$/u.test(value);
}

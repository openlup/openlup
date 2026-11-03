/** Internal identity spelling; fractional digits never pass through a number. */
export function nativeInstant(value: string): string {
  const match = /^(\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2})(?:\.(\d{1,6}))?(Z|([+-])(\d{2}):(\d{2}))$/.exec(value);
  if (!match) throw new Error("native_instant_invalid");
  const [, seconds, fraction = "", zone, sign, hours = "00", minutes = "00"] = match;
  const local = Date.parse(`${seconds}Z`);
  if (!Number.isFinite(local) || new Date(local).toISOString().slice(0, 19) !== seconds
    || Number(hours) > 23 || Number(minutes) > 59) throw new Error("native_instant_invalid");
  const offset = zone === "Z" ? 0 : (Number(hours) * 3600 + Number(minutes) * 60) * (sign === "+" ? 1 : -1);
  const utc = new Date(local - offset * 1000).toISOString();
  if (!/^\d{4}-/.test(utc)) throw new Error("native_instant_invalid");
  return `${utc.slice(0, 19)}.${fraction.padEnd(6, "0")}Z`;
}

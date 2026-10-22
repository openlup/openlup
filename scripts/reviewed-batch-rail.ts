import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { BatchedForwardBinding } from "./reviewed-platform-forward.ts";

/** Replay every committed file through the last pin, filling only an absent suffix. */
export function reviewedBatchPaths(root: string, directory: string, pins: BatchedForwardBinding[]): string[] {
  const last = pins.at(-1)?.path;
  if (!last) throw new Error("reviewed batch rail has no pins");
  let absent = false;
  for (const pin of pins) {
    if (!existsSync(join(root, pin.path))) absent = true;
    else if (absent) throw new Error("reviewed batch requires every earlier same-rail pin landed first");
  }
  const committed = readdirSync(join(root, directory)).filter(path => path.endsWith(".sql"))
    .map(path => `${directory}/${path}`).filter(path => path <= last);
  return [...new Set([...committed, ...pins.map(pin => pin.path)])].sort();
}

/** A landed pin must equal the frozen fixture; each pin is applied once. */
export function reviewedBatchBytes(root: string, fixtureRoot: string, pin: BatchedForwardBinding): Buffer {
  const fixture = readFileSync(join(fixtureRoot, "scripts/fixtures/reviewed-m10", pin.path));
  const path = join(root, pin.path);
  if (!existsSync(path)) return fixture;
  const landed = readFileSync(path);
  if (!landed.equals(fixture)) throw new Error(`reviewed batch landed bytes drifted: ${pin.path}`);
  return landed;
}

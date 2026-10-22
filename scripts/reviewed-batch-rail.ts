import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import type { BatchedForwardBinding } from "./reviewed-platform-forward.ts";

/** Replay only the committed prefix before this rail's first approved pin. */
export function reviewedBatchPrefix(root: string, directory: string, pins: BatchedForwardBinding[]): string[] {
  const paths = new Set(pins.map(pin => pin.path));
  const first = pins.map(pin => pin.path).sort()[0];
  if (!first) throw new Error("reviewed batch rail has no pins");
  return readdirSync(join(root, directory)).filter(path => path.endsWith(".sql"))
    .map(path => `${directory}/${path}`).filter(path => !paths.has(path) && path < first).sort();
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

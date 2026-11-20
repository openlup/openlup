/** Static contracts for the existing dead-owner implementation; no cleanup policy changes. */
export interface DisposableDecision {
  decision: "keep" | "dead";
  reason: string;
}

export interface DisposableProbe {
  platform: string;
  hostname(): string;
  pidns?(): string | undefined;
  kill(pid: number, signal: 0): unknown;
  ps(pid: number): string;
}

export interface DisposableSweepRecord extends DisposableDecision {
  id?: string;
  action?: "keep" | "would_remove" | "removed";
}

export function currentRunId(): string | undefined;
export function hasDisposableRunActivity(run: string | undefined): boolean;
export function clearDisposableRunActivity(run: string | undefined): void;
export function hasTargetedTestArgs(argv?: readonly string[]): boolean;
export function disposableLabelArgs(options?: { run?: string }): string[];
export function parseOwnerStart(value: string): number;
export function ownerStart(pid: number | string, env?: NodeJS.ProcessEnv, timeout?: number): Promise<number>;
export function classify(
  container: unknown,
  probe: DisposableProbe,
  now: number,
  options?: { minAgeSeconds?: number },
): DisposableDecision;
export function sweep(options?: {
  mode?: "report" | "remove";
  selector?: string;
  docker?: string;
  minAgeSeconds?: number;
  budgetMs?: number;
}): Promise<DisposableSweepRecord[]>;

import {
  percentile,
  type MemoryCpuSnapshot,
  type SoakCase,
  type SoakCaseKind,
  type SoakConfig,
  type SoakSample,
} from "./local-bff-soak-core.ts";

type SoakGroupAccumulator = {
  count: number;
  ok: number;
  failed: number;
  unexpected4xx: number;
  fiveXx: number;
  durations: number[];
};

type SoakGroupSummary = {
  count: number;
  ok: number;
  failed: number;
  unexpected4xx: number;
  fiveXx: number;
  p95Ms: number | null;
  p99Ms: number | null;
  maxMs: number | null;
};

export type SoakAccumulator = {
  totals: SoakGroupAccumulator;
  byCase: Record<string, SoakGroupAccumulator>;
  byKind: Record<SoakCaseKind, SoakGroupAccumulator>;
};

const SOAK_KINDS: SoakCaseKind[] = ["fast-read", "read", "dynamic-post"];

export function createSoakAccumulator(cases: Pick<SoakCase, "name" | "kind">[]): SoakAccumulator {
  return {
    totals: createGroupAccumulator(),
    byCase: Object.fromEntries(cases.map((testCase) => [testCase.name, createGroupAccumulator()])),
    byKind: Object.fromEntries(SOAK_KINDS.map((kind) => [kind, createGroupAccumulator()])) as Record<SoakCaseKind, SoakGroupAccumulator>,
  };
}

export function recordSoakSample(accumulator: SoakAccumulator, sample: SoakSample): void {
  recordGroupSample(accumulator.totals, sample);
  const caseGroup = accumulator.byCase[sample.caseName] ?? createGroupAccumulator();
  accumulator.byCase[sample.caseName] = caseGroup;
  recordGroupSample(caseGroup, sample);
  recordGroupSample(accumulator.byKind[sample.kind], sample);
}

export function summarizeSoak(samples: SoakSample[], snapshot: MemoryCpuSnapshot, config: SoakConfig) {
  const accumulator = createSoakAccumulator([...new Map(samples.map((sample) => [
    sample.caseName,
    { name: sample.caseName, kind: sample.kind },
  ])).values()]);
  for (const sample of samples) {
    recordSoakSample(accumulator, sample);
  }
  return summarizeSoakAccumulator(accumulator, snapshot, config);
}

export function summarizeSoakAccumulator(accumulator: SoakAccumulator, snapshot: MemoryCpuSnapshot, config: SoakConfig) {
  const byCase = Object.fromEntries(Object.entries(accumulator.byCase)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([caseName, group]) => [caseName, summarizeAccumulatedGroup(group)]));
  const byKind = Object.fromEntries(SOAK_KINDS.map((kind) => [
    kind,
    summarizeAccumulatedGroup(accumulator.byKind[kind]),
  ])) as Record<SoakCaseKind, SoakGroupSummary>;
  const totals = summarizeAccumulatedGroup(accumulator.totals);
  const failures = thresholdFailures({
    totals,
    fastRead: byKind["fast-read"],
    dynamicPost: byKind["dynamic-post"],
    snapshot,
    config,
  });

  return {
    ok: failures.length === 0,
    totals,
    byCase,
    byKind,
    thresholds: config.thresholds,
    thresholdFailures: failures,
    resources: snapshot,
  };
}

export function summarizeGroup(samples: SoakSample[]): SoakGroupSummary {
  const group = createGroupAccumulator();
  for (const sample of samples) {
    recordGroupSample(group, sample);
  }
  return summarizeAccumulatedGroup(group);
}

function createGroupAccumulator(): SoakGroupAccumulator {
  return {
    count: 0,
    ok: 0,
    failed: 0,
    unexpected4xx: 0,
    fiveXx: 0,
    durations: [],
  };
}

function recordGroupSample(group: SoakGroupAccumulator, sample: SoakSample): void {
  group.count += 1;
  if (sample.ok) {
    group.ok += 1;
  } else {
    group.failed += 1;
  }
  if (sample.unexpected4xx) group.unexpected4xx += 1;
  if (sample.fiveXx) group.fiveXx += 1;
  group.durations.push(sample.durationMs);
}

function summarizeAccumulatedGroup(group: SoakGroupAccumulator): SoakGroupSummary {
  return {
    count: group.count,
    ok: group.ok,
    failed: group.failed,
    unexpected4xx: group.unexpected4xx,
    fiveXx: group.fiveXx,
    p95Ms: percentile(group.durations, 95),
    p99Ms: percentile(group.durations, 99),
    maxMs: maxValue(group.durations),
  };
}

function maxValue(values: number[]): number | null {
  if (values.length === 0) return null;
  let max = values[0];
  for (let index = 1; index < values.length; index += 1) {
    if (values[index] > max) max = values[index];
  }
  return max;
}

function thresholdFailures(input: {
  totals: SoakGroupSummary;
  fastRead: SoakGroupSummary;
  dynamicPost: SoakGroupSummary;
  snapshot: MemoryCpuSnapshot;
  config: SoakConfig;
}): string[] {
  if (!input.config.enforceThresholds) return [];
  const failures: string[] = [];
  const { totals, fastRead, dynamicPost } = input;

  if (totals.failed > 0) failures.push(`expected 0 failed samples, got ${totals.failed}`);
  if (totals.fiveXx > 0) failures.push(`expected 0 5xx, got ${totals.fiveXx}`);
  if (totals.unexpected4xx > 0) failures.push(`expected 0 unexpected 4xx, got ${totals.unexpected4xx}`);
  if ((fastRead.p95Ms ?? 0) > input.config.thresholds.fastReadP95Ms) {
    failures.push(`fast-read p95 ${fastRead.p95Ms}ms > ${input.config.thresholds.fastReadP95Ms}ms`);
  }
  if ((dynamicPost.p95Ms ?? 0) > input.config.thresholds.dynamicPostP95Ms) {
    failures.push(`dynamic-post p95 ${dynamicPost.p95Ms}ms > ${input.config.thresholds.dynamicPostP95Ms}ms`);
  }
  if ((dynamicPost.p99Ms ?? 0) > input.config.thresholds.dynamicPostP99Ms) {
    failures.push(`dynamic-post p99 ${dynamicPost.p99Ms}ms > ${input.config.thresholds.dynamicPostP99Ms}ms`);
  }
  if (input.snapshot.rssPeakBytes > input.config.thresholds.rssPeakBytes) {
    failures.push(`rss peak ${input.snapshot.rssPeakBytes} > ${input.config.thresholds.rssPeakBytes}`);
  }
  return failures;
}

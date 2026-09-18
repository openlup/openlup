const DEFAULT_QUEUE_STUCK_MS = 10 * 60 * 1000;

function result(classification: string, reason: string, action: string) {
  return { classification, reason, action };
}

export function classifyQueuedRun(run: Record<string, unknown>, nowMs = Date.now(), thresholdMs = DEFAULT_QUEUE_STUCK_MS) {
  const jobs = Array.isArray(run.jobs) ? run.jobs as Array<Record<string, unknown>> : [];
  const job = jobs.find((item) =>
    (item.status === "queued" || item.conclusion === "cancelled") &&
    (!Array.isArray(item.steps) || item.steps.length === 0)
  );
  const createdAt = typeof run.createdAt === "string" ? run.createdAt : "";
  const createdMs = Date.parse(createdAt);
  if (!job || !Number.isFinite(createdMs) || nowMs - createdMs < thresholdMs) return null;
  return {
    ...result(
      "github_actions_runner_queue_stuck",
      "A GitHub Actions job is queued with no runner steps after the stuck threshold.",
      "Cancel only stuck queued runs for the current head SHA, then retrigger checks; do not edit product code as the recovery.",
    ),
    run: {
      id: run.databaseId,
      workflowName: run.workflowName,
      headSha: run.headSha,
      createdAt: run.createdAt,
      status: run.status,
    },
    job: { id: job.databaseId, name: job.name, status: job.status, startedAt: job.startedAt },
  };
}

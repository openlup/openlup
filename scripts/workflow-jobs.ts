// Minimal reader for a workflow's top-level `jobs:` block.
//
// Deliberately NOT a YAML parser. `yaml`/`js-yaml` are in neither package.json nor
// node_modules, and adding one would land in `isFullFallbackFile` and perturb the CI
// tier system for every PR. Every existing workflow test in this repo (~20 of them)
// reads workflow YAML by raw-text slicing; this is that same convention factored into
// one tested helper instead of copy-pasted per test.
//
// The fragility is bounded: `validate:workflows` already runs a real YAML load plus
// actionlint over these files, so anything reaching here is well-formed with canonical
// indentation. And it fails CLOSED — a job this cannot see is a job that is not in the
// catalog, which is an error, not a silent pass.

export type WorkflowJob = {
  /** Job id — the key under `jobs:`. */
  id: string;
  /** `name:` if declared; this is what renders as the GitHub check. */
  name?: string;
  /** Job-level `if:` if declared. */
  ifExpr?: string;
  line: number;
  /** Bounded raw YAML for this job only; never matches a command in another job. */
  raw: string;
};

const JOB_ID = /^ {2}([A-Za-z_][A-Za-z0-9_-]*):\s*$/;
const JOB_FIELD = /^ {4}(name|if):\s*(.*)$/;

/** Strip one layer of matching quotes — `name: "x"` and `name: x` mean the same job. */
function unquote(value: string): string {
  const trimmed = value.trim();
  if (trimmed.length >= 2 && (trimmed.startsWith('"') || trimmed.startsWith("'"))) {
    const quote = trimmed[0];
    if (trimmed.endsWith(quote)) return trimmed.slice(1, -1);
  }
  return trimmed;
}

export function listWorkflowJobs(text: string): WorkflowJob[] {
  const lines = text.split(/\r?\n/);
  const jobs: WorkflowJob[] = [];

  let inJobs = false;
  let current: WorkflowJob | null = null;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (/^jobs:\s*$/.test(line)) {
      inJobs = true;
      continue;
    }
    if (!inJobs) continue;

    // Any other top-level key ends the jobs block.
    if (/^[A-Za-z_]/.test(line)) break;

    const jobMatch = JOB_ID.exec(line);
    if (jobMatch) {
      current = { id: jobMatch[1], line: index + 1, raw: "" };
      jobs.push(current);
      continue;
    }

    if (!current) continue;
    const fieldMatch = JOB_FIELD.exec(line);
    // Only the FIRST name/if at job depth belongs to the job — a later one at the same
    // indent is inside a step and must not overwrite it.
    if (fieldMatch) {
      const [, key, raw] = fieldMatch;
      if (key === "name" && current.name === undefined) current.name = unquote(raw);
      if (key === "if" && current.ifExpr === undefined) current.ifExpr = unquote(raw);
    }
  }

  for (let index = 0; index < jobs.length; index += 1) {
    const end = index + 1 < jobs.length ? jobs[index + 1].line - 1 : lines.length;
    jobs[index].raw = lines.slice(jobs[index].line - 1, end).join("\n");
  }
  return jobs;
}

/** The GitHub check name a job renders as: its `name:`, else its id. */
export function checkNameOf(job: WorkflowJob): string {
  return job.name ?? job.id;
}

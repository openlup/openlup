import {
  checkReadiness,
  type ReadinessInput,
  type ReadinessIssue,
  type ReadinessReport,
  type RequiredSchema,
  type SchemaObservation,
} from "@openlup/core/readiness";

/** Evidence from the existing readiness declarations, bindings and observer only. */
export interface AppVerificationFinding {
  code: ReadinessIssue["code"];
  package: string;
  module?: string;
  subject: string;
  observed: string;
  cause: string;
  fix: string;
  recheck: string;
  evidence: {
    declared: string;
    bound: string;
    checked: string;
    unknown: readonly string[];
  };
}

/** This describes the supplied composition; it is not operational qualification. */
export interface AppVerificationReport {
  state: ReadinessReport["state"];
  boundary: string;
  candidate: ReadinessReport["candidate"];
  loadedPackages: ReadinessReport["loadedPackages"];
  findings: readonly AppVerificationFinding[];
}

export const APP_VERIFICATION_BOUNDARY = "Read-only diagnosis of supplied composition observations. Only the supplied schema observer is called; handlers, routes, schedules, migrations and installs are never run. Host inventory, bindings and probe honesty remain application-owned. No SQL behavior, ACL, provider delivery or live scheduler execution is proven.";

/** Reuses the one readiness evaluator; the caller owns read-only observation. */
export async function verifyApp(input: ReadinessInput): Promise<AppVerificationReport> {
  const observations = new Map<RequiredSchema, SchemaObservation>();
  const observedInput = typeof input?.schemaProbe?.observe === "function" ? {
    ...input,
    schemaProbe: { async observe(requirement: RequiredSchema) {
      const observation = await input.schemaProbe.observe(requirement);
      observations.set(requirement, observation);
      return observation;
    } },
  } : input;
  const report = await checkReadiness(observedInput);
  return {
    state: report.state,
    boundary: APP_VERIFICATION_BOUNDARY,
    candidate: report.candidate,
    loadedPackages: report.loadedPackages,
    findings: report.issues.map(issue => describeFinding(input, issue, observations)),
  };
}

function describeFinding(input: ReadinessInput, issue: ReadinessIssue, observations: Map<RequiredSchema, SchemaObservation>): AppVerificationFinding {
  const contribution = input?.contributions?.find(item => item?.manifest?.name === issue.package && item.manifest.module?.id === issue.module);
  const manifest = contribution?.manifest;
  const owner = issue.module ? `${issue.package}/${issue.module}` : issue.package;
  let observed = issue.observation ?? "The selected composition does not satisfy this readiness requirement.";
  let cause = "A declaration and the supplied host observations do not agree.";
  let fix = issue.fix;
  let declared = manifest ? `Selected contribution ${owner}.` : "No valid matching contribution established.";
  let bound = "Not established for this finding.";
  let checked = "Readiness comparison of supplied observations only.";
  const unknown = ["Actual execution, permissions and external effects were not checked."];

  if (issue.code === "OPENLUP_E_PORT_MISSING") {
    const key = `${owner}:${issue.subject}`;
    const portDeclared = manifest?.requiredPorts?.includes(issue.subject);
    const routeDeclared = manifest?.routes?.includes(issue.subject);
    const port = input.bindings?.ports?.[key];
    const portBound = typeof port === "function" || (port !== null && typeof port === "object" && !Array.isArray(port));
    const routes = contribution?.routes?.filter(item => item.id === issue.subject) ?? [];
    const routeBound = routes.length === 1 && typeof routes[0]?.handle === "function" && input.bindings?.routes?.[key] === routes[0].handle;
    const declarations: string[] = [], bindings: string[] = [];
    if (portDeclared) {
      declarations.push(`Port ${issue.subject} is required.`);
      bindings.push(`bindings.ports[${JSON.stringify(key)}]: ${portBound ? "object/function supplied" : "missing usable port"}.`);
      if (!portBound) fix += ` Supply the adapter through the application binder and expose its returned object or function at bindings.ports[${JSON.stringify(key)}]. Do not use a declaration string.`;
    }
    if (routeDeclared) {
      declarations.push(`Route ${issue.subject} is declared.`);
      bindings.push(`bindings.routes[${JSON.stringify(key)}]: ${routeBound ? "matches composed handler" : "missing/mismatched handler"}.`);
      if (!routeBound) fix += ` Set bindings.routes[${JSON.stringify(key)}] to the actual contribution.routes handler for this id.`;
    }
    if (declarations.length) declared = declarations.join(" ");
    if (bindings.length) observed = bindings.join(" ");
    bound = bindings.length ? bindings.join(" ") : "No usable host binding established.";
    const missing = [portDeclared && !portBound ? "the required adapter port" : "", routeDeclared && !routeBound ? "the selected route handler" : ""].filter(Boolean);
    cause = missing.length ? `Application composition is missing or mismatches ${missing.join(" and ")}.` : "Host binding metadata does not satisfy the selected contribution.";
  } else if (issue.code === "OPENLUP_E_SCHEDULE_UNBOUND") {
    const key = `${owner}:${issue.subject}`;
    const schedule = manifest?.schedules?.find(item => item.id === issue.subject);
    declared = schedule ? `Schedule ${schedule.id}, cadenceSeconds=${schedule.cadenceSeconds}.` : declared;
    observed = `The declared schedule, contribution.schedules callable/cadence and bindings.triggers[${JSON.stringify(key)}] do not all match.`;
    cause = "The selected job is absent, has a different cadence, or is not wired to its actual host trigger.";
    bound = "Not established: all three schedule observations must agree.";
    fix += ` Keep the declared cadence in contribution.schedules; register that same run function with the host scheduler and expose it at bindings.triggers[${JSON.stringify(key)}]. Merely copying a function into the report does not register a timer.`;
    unknown.push("Timer registration and job execution require the host's own observation.");
  } else if (issue.code === "OPENLUP_E_SCHEMA_BEHIND") {
    declared = manifest?.requiredSchema ? `Schema version ${manifest.requiredSchema.version}; migration ${manifest.requiredSchema.migration}.` : "Schema observation is required.";
    observed = issue.observation ?? "No valid schema observer or bounded observation was supplied.";
    const observation = manifest?.requiredSchema ? observations.get(manifest.requiredSchema) : undefined;
    if (issue.observation === "version_mismatch" && typeof observation?.version === "string" && /^[a-zA-Z0-9_./:-]{1,240}$/u.test(observation.version)) {
      observed = `Observed migration identity ${JSON.stringify(observation.version)} differs from required ${JSON.stringify(manifest?.requiredSchema?.version)} (version_mismatch).`;
    }
    cause = issue.observation === "version_mismatch" ? "The observed migration identity differs from the selected contribution's schema requirement." : issue.observation === "object_absent" ? "A required schema object was observed absent." : "Schema evidence is missing, unavailable, incomplete or does not identify the candidate database.";
    bound = typeof input?.schemaProbe?.observe === "function" ? "A schema observation function was supplied." : "No callable schema observer was supplied.";
    checked = ["version_mismatch", "object_absent"].includes(issue.observation ?? "") ? "A bounded observation returned a concrete mismatch." : "Unknown; this finding is not proof of a stale database.";
    unknown.push("Catalog presence does not prove SQL bodies, privileges or migration safety.");
  } else if (issue.code === "OPENLUP_E_ENV_MISSING") {
    declared = `Environment name ${issue.subject} is required; values are never reported.`;
    observed = "The required environment entry is absent or blank.";
    cause = "The selected application configuration lacks a required setting.";
    bound = "No nonblank setting was observed.";
  } else if (issue.code === "OPENLUP_E_EVENT_UNHANDLED" || issue.code === "OPENLUP_E_EVENT_DUPLICATE") {
    cause = "The event's declared producer, actual consumer descriptors or owned exemption are missing or ambiguous.";
    observed = issue.observation ?? `Readiness refused event/descriptor ${issue.subject}.`;
    bound = "No unambiguous complete handler/exemption mapping established.";
  }
  return {
    code: issue.code, package: issue.package, ...(issue.module ? { module: issue.module } : {}), subject: issue.subject,
    observed, cause, fix, recheck: "Run openlup verify with the same explicit --app module after repairing the application composition or migration chain.",
    evidence: { declared, bound, checked, unknown },
  };
}

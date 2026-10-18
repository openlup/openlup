import { pathToFileURL } from "node:url";
import { createPostgresOperatorIdentityStore, createPostgresCustomerChallengeStore } from "@openlup/platform/identity";
import { readProcessEnvironment } from "../../_lib/observability/runtimeProvenance.ts";
export async function runOperatorIdentityCommand(args: string[], env: Record<string, string | undefined>) {
  if (env.PLATFORM_BUNDLE !== "node-postgres" || !env.DATABASE_URL?.trim()) throw new Error("operator_identity_database_required");
  const [command, flag, value, ...extra] = args;
  if (extra.length || !((command === "bootstrap-first-administrator" && flag === "--email" && value)
    || (command === "prune-challenges" && !flag))) throw new Error("operator_identity_command_invalid");
  const store = createPostgresOperatorIdentityStore({ connectionString: env.DATABASE_URL });
  try {
    if (command === "bootstrap-first-administrator") return await store.bootstrapFirstAdministrator({ email: value });
    const customer = createPostgresCustomerChallengeStore({ connectionString: env.DATABASE_URL });
    try { return { operator: await store.pruneChallenges({ limit: 500 }), customer: await customer.pruneChallenges({ limit: 500 }) }; }
    finally { await customer.close(); }
  } finally { await store.close(); }
}
if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  runOperatorIdentityCommand(process.argv.slice(2), readProcessEnvironment()).then(result => console.info(JSON.stringify(result)), (error: unknown) => { console.error(error instanceof Error && error.message === "OPERATOR_BOOTSTRAP_ALREADY_INITIALIZED" ? error.message : "operator_identity_command_failed"); process.exitCode = 1; });
}

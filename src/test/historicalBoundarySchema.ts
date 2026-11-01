import { allMigrations } from "./effectiveMigration.js";

/** Selected installed trigger DDL, including later replacements or removals. */
export function currentTrigger(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Invalid trigger name: ${name}`);
  let definition: string | undefined;
  const statements = new RegExp(`(?:CREATE TRIGGER ${name}\\b|DROP TRIGGER(?: IF EXISTS)? ${name}\\b)[^;]*;`, "gi");
  for (const migration of allMigrations()) {
    for (const match of migration.content.matchAll(statements)) {
      definition = /^DROP/i.test(match[0]) ? undefined : match[0];
    }
  }
  if (!definition) throw new Error(`No installed trigger definition: ${name}`);
  return definition;
}

/** Explicit function ACL statements in chain order; live SQL owns effective privileges. */
export function functionAclStatements(name: string): string[] {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Invalid function name: ${name}`);
  const result: string[] = [];
  // An explicit ACL may name several regprocedures; return only the requested
  // target, so callers replaying these statements never grant a neighboring RPC.
  const statement = /(?:GRANT|REVOKE)\s+(?:ALL|EXECUTE)\s+ON FUNCTION\s+[^;]+?\s+(?:TO|FROM)\s+[^;]+;/gi;
  for (const { content } of allMigrations()) for (const [sql] of content.matchAll(statement)) {
    const acl = sql.match(/^(GRANT|REVOKE)\s+(ALL|EXECUTE)\s+ON FUNCTION\s+(.*?)\s+(TO|FROM)\s+([^;]+);$/s);
    if (!acl) throw new Error("Unsupported explicit function ACL");
    for (const target of acl[3].matchAll(/public\.([a-z0-9_]+)\(([^()]*)\)/g)) {
      if (target[1] === name) result.push(acl[1] + " " + acl[2] + " ON FUNCTION " + target[0] + " " + acl[4] + " " + acl[5] + ";");
    }
  }
  if (!result.length) throw new Error(`No explicit function ACL: ${name}`);
  return result;
}

/** Final explicit EXECUTE ACL for each observed overload; role inheritance is a live-DB obligation. */
export function explicitFunctionExecuteRoles(name: string): Map<string, Set<string>> {
  const overloads = new Map<string, Set<string>>();
  for (const sql of functionAclStatements(name)) {
    const match = sql.match(/^(GRANT|REVOKE)\s+(ALL|EXECUTE)\s+ON FUNCTION public\.[a-z0-9_]+\((.*?)\)\s+(?:TO|FROM)\s+([^;]+);$/s);
    if (!match) throw new Error(`Unsupported function ACL statement: ${sql}`);
    // pg_dump includes parameter names while additive grants can omit them.
    const signature = match[3].split(",").map((argument) => argument.trim().replace(/^p_[a-z_]+\s+/, "").replace(/\btimestamptz\b/g, "timestamp with time zone").replace(/\s+/g, " ")).join(",");
    const roles = overloads.get(signature) ?? new Set(["PUBLIC"]);
    for (const role of match[4].split(",").map((role) => role.trim())) {
      if (match[1] === "GRANT") roles.add(role);
      else roles.delete(role);
    }
    overloads.set(signature, roles);
  }
  return overloads;
}

/** Object-scoped table definition, constraints, indexes, RLS and policies from the selected chain. */
export function currentTableStatements(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) throw new Error(`Invalid table name: ${name}`);
  const schema = `public\\.${name}`;
  const matcher = new RegExp(`^(?:CREATE TABLE(?: IF NOT EXISTS)? ${schema}\\s*\\(|ALTER TABLE(?: ONLY)? ${schema}\\b|CREATE (?:UNIQUE )?INDEX [^\\n]* ON ${schema}\\b|CREATE POLICY [^\\n]* ON ${schema}\\b|(?:GRANT|REVOKE) [^\\n]* ON TABLE ${schema}\\b)[\\s\\S]*?;`, "gm");
  const selected = allMigrations().flatMap(({ content }) => {
    if (new RegExp(`^DROP TABLE(?: IF EXISTS)? ${schema}\\b|^ALTER TABLE(?: ONLY)? ${schema}[^;]*\\b(?:DROP|DISABLE ROW LEVEL SECURITY)\\b`, "m").test(content)) {
      throw new Error(`Destructive table change requires explicit schema resolution: ${name}`);
    }
    return [...content.matchAll(matcher)].map(([sql]) => sql);
  });
  if (!selected.some((sql) => /^CREATE TABLE/.test(sql))) throw new Error(`Missing installed table: ${name}`);
  return selected.join("\n");
}

export function explicitTablePrivileges(name: string): Map<string, Set<string>> {
  const roles = new Map<string, Set<string>>();
  const all = ["SELECT", "INSERT", "UPDATE", "DELETE", "TRUNCATE", "REFERENCES", "TRIGGER", "MAINTAIN"];
  const matcher = /^(GRANT|REVOKE) ([A-Z, ]+) ON TABLE public\.[a-z0-9_]+ (?:TO|FROM) ([^;]+);$/gm;
  for (const match of currentTableStatements(name).matchAll(matcher)) {
    const privileges = match[2] === "ALL" ? all : match[2].split(",").map((privilege) => privilege.trim());
    for (const role of match[3].split(",").map((role) => role.trim())) {
      const effective = roles.get(role) ?? new Set<string>();
      for (const privilege of privileges) {
        if (match[1] === "GRANT") effective.add(privilege);
        else effective.delete(privilege);
      }
      roles.set(role, effective);
    }
  }
  return roles;
}

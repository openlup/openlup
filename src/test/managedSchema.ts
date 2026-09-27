import { allMigrations, effectiveFunctionBody } from "./effectiveMigration.js";

const identifier = (name: string) => {
  if (!/^[a-z][a-z0-9_]*$/.test(name)) throw new Error(`invalid SQL object name: ${name}`);
  return name;
};

/** Read the published end state, including constraints, policies and explicit ACLs. */
export function managedTable(name: string): string {
  return readManagedTable(allMigrations().map(({ content }) => content).join("\n"), name);
}

export function readManagedTable(sql: string, name: string): string {
  identifier(name);
  const definition = sql.match(new RegExp(`^CREATE TABLE (?:IF NOT EXISTS )?public\\.${name} \\([\\s\\S]*?^\\);`, "m"))?.[0];
  if (!definition) throw new Error(`published schema has no public.${name}`);
  const statements = [...sql.matchAll(new RegExp(
    `^(?:ALTER TABLE (?:ONLY )?public\\.${name}\\b|(?:GRANT|REVOKE) [^;\\n]+ ON TABLE public\\.${name}\\b|CREATE POLICY [^;\\n]+ ON public\\.${name}\\b)[\\s\\S]*?;`, "gm",
  ))].map(([statement]) => statement);
  return [definition, ...statements].join("\n");
}

export function managedFunction(name: string): string {
  identifier(name);
  const grants = allMigrations().flatMap(({ content }) => [...content.matchAll(new RegExp(
    `^(?:GRANT|REVOKE) [^;\\n]+ ON FUNCTION public\\.${name}\\([\\s\\S]*?;`, "gm",
  ))].map(([statement]) => statement));
  return [effectiveFunctionBody(name), ...grants].join("\n");
}

export function declaredTableGrants(sql: string, role: string): string[] {
  identifier(role);
  const grants = new Set<string>();
  for (const [, operation, privileges, roles] of sql.matchAll(/(GRANT|REVOKE) ([^;]+?) ON TABLE [^;]+? (?:TO|FROM) ([^;]+);/g)) {
    if (!roles.split(",").map((value) => value.trim()).includes(role)) continue;
    for (const privilege of privileges.split(",").map((value) => value.trim())) {
      if (operation === "GRANT") grants.add(privilege);
      else if (privilege === "ALL") grants.clear();
      else grants.delete(privilege);
    }
  }
  return [...grants].sort();
}

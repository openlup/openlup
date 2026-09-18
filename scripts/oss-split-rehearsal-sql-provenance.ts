export type TargetProvenance = "edge-function" | "application-cron";
export type PendingGuard = { variable: string; provenance: TargetProvenance; depth: number; rejects: boolean; invalid: boolean };

/** Only a complete rejecting, anchored route guard proves a local base namespace. */
export function rejectingNamespaceGuard(line: string): Omit<PendingGuard, "depth" | "rejects" | "invalid"> | null {
  const statement = /^\s*IF\s+(.+?)\s+THEN\s*$/i.exec(line);
  if (!statement) return null;
  const condition = /^\s*(?:lower\(\s*)?(v_[a-z0-9_]+)\s*\)?\s*(NOT\s+LIKE|!~)\s*'([^']*)'\s*$/i.exec(statement[1]);
  if (!condition) return null;
  const [, variable, operator, quoted] = condition;
  if (/[|()\\]/.test(quoted)) return null;
  const route = operator.includes("~")
    ? /^\^https:\/\/[^/|()\\\s]+\/(functions\/v1|api\/cron)\/?\$$/i.exec(quoted)
    : /^https:\/\/[^/\s]+\/(functions\/v1|api\/cron)\/?%$/i.exec(quoted);
  if (!route) return null;
  return { variable, provenance: route[1].toLowerCase() === "functions/v1" ? "edge-function" : "application-cron" };
}

type ColumnContract = { provenance: TargetProvenance; optionalTrailingSlash: boolean };
const withoutSqlComments = (source: string): string => source.replace(/\/\*[\s\S]*?\*\//g, "").split("\n").map((line) => line.replace(/--.*$/, "")).join("\n");

function checkedColumnContracts(source: string): Map<string, Map<string, ColumnContract>> {
  const tables = new Map<string, Map<string, ColumnContract>>();
  const tablePattern = /CREATE\s+TABLE(?:\s+IF\s+NOT\s+EXISTS)?\s+([a-z_][a-z0-9_.]*)\s*\(([\s\S]*?)^\s*\);/gim;
  for (const table of withoutSqlComments(source).matchAll(tablePattern)) {
    const columns = new Map<string, ColumnContract>();
    const checkPattern = /CHECK\s*\(\s*([a-z_][a-z0-9_]*)\s+IS\s+NULL\s+OR\s+([a-z_][a-z0-9_]*)\s*~\s*'([^']+)'\s*\)/gi;
    for (const check of table[2].matchAll(checkPattern)) {
      const column = check[1].toLowerCase();
      if (column !== check[2].toLowerCase() || !new RegExp(`^\\s*${column}\\s+[a-z_]`, "im").test(table[2])) continue;
      const route = /^\^https:\/\/[^/|()\s]+\/(functions\/v1|api\/cron)(\/\?)?\$$/i.exec(check[3]);
      if (!route) continue;
      columns.set(column, { provenance: route[1].toLowerCase() === "functions/v1" ? "edge-function" : "application-cron", optionalTrailingSlash: route[2] !== undefined });
    }
    if (columns.size > 0) tables.set(table[1].toLowerCase(), columns);
  }
  return tables;
}

function selectedColumn(expression: string): string | null {
  const compact = expression.replace(/\s+/g, " ").trim();
  const wrapped = /^NULLIF\(\s*BTRIM\(\s*([a-z_][a-z0-9_]*)\s*\)\s*,\s*''\s*\)$/i.exec(compact);
  return (wrapped ?? /^([a-z_][a-z0-9_]*)$/i.exec(compact))?.[1].toLowerCase() ?? null;
}

function safelyNormalizesTrailingSlash(expression: string, variable: string): boolean {
  const escaped = variable.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^regexp_replace\\(\\s*${escaped}\\s*,\\s*'\\/\\+\\$'\\s*,\\s*''\\s*\\)$`, "i").test(expression.trim());
}

/** Prove a file-local helper only through its checked column, data flow, normalization and returns. */
export function checkedHelperContracts(source: string): Map<string, TargetProvenance> {
  const helpers = new Map<string, TargetProvenance>();
  const uncommented = withoutSqlComments(source);
  const tables = checkedColumnContracts(uncommented);
  const functionPattern = /CREATE(?:\s+OR\s+REPLACE)?\s+FUNCTION\s+([a-z_][a-z0-9_.]*)\s*\(\s*\)([\s\S]*?)AS\s+\$([a-z0-9_]*)\$([\s\S]*?)^\s*\$\3\$;/gim;
  for (const routine of uncommented.matchAll(functionPattern)) {
    helpers.delete(routine[1].toLowerCase());
    if (!/\bRETURNS\s+text\b/i.test(routine[2])) continue;
    const selections = [...routine[4].matchAll(/^\s*SELECT\s+([\s\S]*?)\s+INTO\s+(v_[a-z0-9_]+)\s+FROM\s+([a-z_][a-z0-9_.]*)[\s\S]*?;/gim)];
    if (selections.length !== 1) continue;
    const [, expression, variable, tableName] = selections[0];
    const column = selectedColumn(expression);
    const contract = column ? tables.get(tableName.toLowerCase())?.get(column) : null;
    if (!contract) continue;
    const intoWrites = [...routine[4].matchAll(/\bINTO\s+(v_[a-z0-9_]+)\b/gi)].filter((write) => write[1].toLowerCase() === variable.toLowerCase());
    if (intoWrites.length !== 1) continue;
    const assignments = [...routine[4].matchAll(/^\s*(v_[a-z0-9_]+)\s*:=\s*(.+?);\s*$/gim)].filter((assignment) => assignment[1].toLowerCase() === variable.toLowerCase());
    if (assignments.some((assignment) => !safelyNormalizesTrailingSlash(assignment[2], variable)) || (contract.optionalTrailingSlash && assignments.length !== 1)) continue;
    const returns = [...routine[4].matchAll(/\bRETURN\s+(.+?);/gi)].map((match) => match[1].trim().toLowerCase());
    if (!returns.includes(variable.toLowerCase()) || returns.some((value) => value !== "null" && value !== variable.toLowerCase())) continue;
    helpers.set(routine[1].toLowerCase(), contract.provenance);
  }
  return helpers;
}

export function rememberHelperSelection(line: string, helpers: Map<string, TargetProvenance>, known: Map<string, string[]>, namespaces: Map<string, TargetProvenance>): void {
  const selectedVariable = /\bINTO\s+(v_[a-z0-9_]+)\b/i.exec(line)?.[1];
  if (selectedVariable) { known.delete(selectedVariable); namespaces.delete(selectedVariable); }
  const selection = /^\s*SELECT\s+([a-z_][a-z0-9_.]*)\s*\(\s*\)\s+INTO\s+(v_[a-z0-9_]+)\s*;\s*$/i.exec(line);
  if (!selection) return;
  const provenance = helpers.get(selection[1].toLowerCase());
  if (provenance) namespaces.set(selection[2], provenance);
}

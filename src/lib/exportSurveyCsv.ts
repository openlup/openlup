type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

export interface SurveyRow {
  id: string;
  created_at: string;
  response_data: Json;
}

function flattenValue(v: Json | undefined): string {
  if (v === null || v === undefined) return "";
  if (Array.isArray(v)) return v.map((x) => flattenValue(x)).join(" | ");
  if (typeof v === "object") {
    return Object.entries(v as Record<string, Json>)
      .map(([k, val]) => `${k}=${flattenValue(val)}`)
      .join("; ");
  }
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

function csvEscape(s: string): string {
  if (/[",\n\r]/.test(s)) return `"${s.replace(/"/g, '""')}"`;
  return s;
}

function collectColumns(rows: SurveyRow[]): string[] {
  const seen = new Set<string>();
  for (const row of rows) {
    if (row.response_data && typeof row.response_data === "object" && !Array.isArray(row.response_data)) {
      for (const k of Object.keys(row.response_data as Record<string, Json>)) {
        seen.add(k);
      }
    }
  }
  return Array.from(seen);
}

const CSV_HEADER_LABELS: Record<string, string> = {
  screen5_usage_combined: "Usage",
  screen12a_company_size: "Company size",
  screen12b_seniority: "Seniority",
};

function headerLabel(key: string): string {
  return CSV_HEADER_LABELS[key] ?? key;
}

export function rowsToCsv(rows: SurveyRow[]): string {
  if (rows.length === 0) return "id,created_at\n";
  const dataCols = collectColumns(rows);
  const header = ["id", "created_at", ...dataCols.map(headerLabel)];
  const lines = [header.map(csvEscape).join(",")];
  for (const row of rows) {
    const dataObj =
      row.response_data && typeof row.response_data === "object" && !Array.isArray(row.response_data)
        ? (row.response_data as Record<string, Json>)
        : {};
    const cells = [
      row.id,
      row.created_at,
      ...dataCols.map((c) => flattenValue(dataObj[c])),
    ];
    lines.push(cells.map(csvEscape).join(","));
  }
  return lines.join("\n") + "\n";
}

export function downloadCsv(filename: string, csv: string): void {
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  const a = document.createElement("a");
  a.href = url;
  a.download = filename;
  document.body.appendChild(a);
  a.click();
  document.body.removeChild(a);
  URL.revokeObjectURL(url);
}

export function todayDateStr(): string {
  const d = new Date();
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

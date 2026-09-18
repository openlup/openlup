import {
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableHeader,
  TableRow,
} from "@/components/ui/table";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { formatDistanceToNow } from "date-fns";
import type { SurveyRow } from "@/lib/exportSurveyCsv";

type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

interface Props {
  type: "producer" | "consumer";
  rows: SurveyRow[];
  onViewJson: (row: SurveyRow) => void;
}

function fieldOf(data: Json, key: string): string {
  if (!data || typeof data !== "object" || Array.isArray(data)) return "—";
  const obj = data as Record<string, Json>;
  const v = obj[key];
  if (v === null || v === undefined || v === "") return "—";
  if (Array.isArray(v)) return v.join(" | ");
  if (typeof v === "boolean") return v ? "yes" : "no";
  return String(v);
}

const COMPANY_SIZE_SHORT: Record<string, string> = {
  "Micro — under 10 employees": "Micro",
  "Small — 10 to 49 employees": "Small",
  "Medium — 50 to 249 employees": "Medium",
  "Large — 250 to 999 employees": "Large",
  "Enterprise — 1,000+ employees": "Enterprise",
  "Prefer not to say": "—",
};

const SENIORITY_SHORT: Record<string, string> = {
  "C-level / Owner / Founder": "C-level",
  "VP / Head of Department": "VP",
  "Director": "Director",
  "Manager": "Manager",
  "Specialist / Individual contributor": "Specialist",
  "Consultant / Advisor": "Consultant",
  "Other": "Other",
};

function shortField(data: Json, key: string, map: Record<string, string>): string {
  const raw = fieldOf(data, key);
  if (raw === "—") return "—";
  return map[raw] ?? raw;
}

const PRODUCER_COLS: { label: string; key: string }[] = [
  { label: "Region", key: "screen2_region" },
  { label: "Role", key: "screen1_role" },
  { label: "Usage", key: "screen5_usage_combined" },
  { label: "Pipeline timing", key: "screen10_pipeline_timing" },
  { label: "Company size", key: "screen12a_company_size" },
  { label: "Seniority", key: "screen12b_seniority" },
  { label: "Opt-in", key: "screen13_opt_in" },
];

const CONSUMER_COLS: { label: string; key: string }[] = [
  { label: "Region", key: "screen12d_region" },
  { label: "Pet type", key: "screen1_pet_type" },
  { label: "Vet scenario", key: "screen7_vet_scenario" },
  { label: "Anchored WTP", key: "screen10b_anchored_wtp" },
  { label: "Age", key: "screen12a_age" },
  { label: "Gender", key: "screen12b_gender" },
  { label: "Household", key: "screen12c_household" },
];

export default function SurveyResponseTable({ type, rows, onViewJson }: Props) {
  const cols = type === "producer" ? PRODUCER_COLS : CONSUMER_COLS;

  if (rows.length === 0) {
    return (
      <div className="rounded-lg border border-warm-sand bg-offwhite p-12 text-center text-text-muted">
        No responses yet. Refresh in 60s.
      </div>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-warm-sand">
      <Table>
        <TableHeader>
          <TableRow className="border-warm-sand hover:bg-transparent">
            <TableHead className="text-text-muted whitespace-nowrap">When</TableHead>
            {cols.map((c) => (
              <TableHead key={c.key} className="text-text-muted whitespace-nowrap">
                {c.label}
              </TableHead>
            ))}
            <TableHead className="text-text-muted"></TableHead>
          </TableRow>
        </TableHeader>
        <TableBody>
          {rows.map((row) => {
            const when = new Date(row.created_at);
            return (
              <TableRow key={row.id} className="border-warm-sand">
                <TableCell className="text-teal-dark/80 whitespace-nowrap">
                  <div>{formatDistanceToNow(when, { addSuffix: true })}</div>
                  <div className="text-xs text-text-muted">
                    {when.toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
                    {" · "}
                    {when.toLocaleDateString([], { day: "numeric", month: "short" })}
                  </div>
                </TableCell>
                {cols.map((c) => {
                  let display = fieldOf(row.response_data, c.key);
                  if (c.key === "screen12a_company_size") {
                    display = shortField(row.response_data, c.key, COMPANY_SIZE_SHORT);
                  } else if (c.key === "screen12b_seniority") {
                    display = shortField(row.response_data, c.key, SENIORITY_SHORT);
                  }
                  return (
                    <TableCell key={c.key} className="text-teal-dark/80 max-w-xs">
                      {c.key === "screen13_opt_in" ? (
                        <Badge
                          variant="outline"
                          className={
                            display === "yes"
                              ? "bg-teal/15 text-teal border-teal/30"
                              : "bg-warm-sand text-text-muted border-offwhite/20"
                          }
                        >
                          {display}
                        </Badge>
                      ) : (
                        <span className="truncate block">{display}</span>
                      )}
                    </TableCell>
                  );
                })}
                <TableCell>
                  <Button
                    variant="outline"
                    size="sm"
                    onClick={() => onViewJson(row)}
                  >
                    View JSON
                  </Button>
                </TableCell>
              </TableRow>
            );
          })}
        </TableBody>
      </Table>
    </div>
  );
}

import {
  aggregateMultiChoice,
  aggregateRanked,
  aggregateSingleChoice,
} from "@/lib/surveyAggregates";
import type { SurveyRow } from "@/lib/exportSurveyCsv";
import {
  Donut,
  HorizontalBar,
  VerticalBar,
  WeightedRanked,
} from "./SurveyCharts";

const PIPELINE_ORDER = [
  "Already in market",
  "Next 6 months",
  "6–12 months",
  "12–24 months",
  "After 2027",
  "No plans currently",
  "Can't disclose",
] as const;

const COMPANY_SIZE_ORDER = [
  "Micro — under 10 employees",
  "Small — 10 to 49 employees",
  "Medium — 50 to 249 employees",
  "Large — 250 to 999 employees",
  "Enterprise — 1,000+ employees",
  "Prefer not to say",
] as const;

const SENIORITY_ORDER = [
  "C-level / Owner / Founder",
  "VP / Head of Department",
  "Director",
  "Manager",
  "Specialist / Individual contributor",
  "Consultant / Advisor",
  "Other",
] as const;

export default function ProducerSurveyCharts({ rows }: { rows: SurveyRow[] }) {
  const n = rows.length;
  const pipeline = aggregateSingleChoice(rows, "screen10_pipeline_timing", {
    order: PIPELINE_ORDER,
  });
  const stance = aggregateSingleChoice(rows, "screen11_stance", {
    sortDesc: true,
  });
  const trigger = aggregateSingleChoice(rows, "screen11b_trigger", {
    sortDesc: true,
  });
  const supplier = aggregateMultiChoice(rows, "screen6b_supplier", {
    sortDesc: true,
  });
  const barriers = aggregateRanked(rows, "screen7_barriers_ranked");
  const companySize = aggregateSingleChoice(rows, "screen12a_company_size", {
    order: COMPANY_SIZE_ORDER,
  });
  const seniority = aggregateSingleChoice(rows, "screen12b_seniority", {
    order: SENIORITY_ORDER,
  });

  return (
    <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
      <VerticalBar title="Pipeline timing" data={pipeline} n={n} />
      <Donut title="Strategic stance" data={stance} n={n} />
      <HorizontalBar title="Adoption triggers" data={trigger} n={n} />
      <HorizontalBar title="Current supplier" data={supplier} n={n} />
      <div className="md:col-span-2">
        <WeightedRanked title="Barriers (weighted top-3)" data={barriers} n={n} />
      </div>
      <VerticalBar title="Company size" data={companySize} n={n} color="#042B2C" />
      <Donut title="Seniority" data={seniority} n={n} />
    </div>
  );
}

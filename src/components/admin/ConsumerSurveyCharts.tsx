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

const WTP_ORDER = [
  "Nothing more — same price or nothing",
  "Up to €3 more",
  "€3–€10 more",
  "€10–€25 more",
  "Over €25 more",
] as const;

const AGE_ORDER = [
  "18–24",
  "25–34",
  "35–44",
  "45–54",
  "55–64",
  "65+",
  "Prefer not to say",
] as const;

const GENDER_ORDER = [
  "Female",
  "Male",
  "Non-binary or other",
  "Prefer not to say",
] as const;

const REGION_ORDER = [
  "Europe",
  "North America",
  "Asia-Pacific",
  "Latin America",
  "Middle East & Africa",
  "Other",
] as const;

export default function ConsumerSurveyCharts({ rows }: { rows: SurveyRow[] }) {
  const n = rows.length;
  const vet = aggregateSingleChoice(rows, "screen7_vet_scenario", {
    sortDesc: true,
  });
  const awareness = aggregateMultiChoice(rows, "screen5_awareness", {
    sortDesc: true,
  });
  const concerns = aggregateSingleChoice(rows, "screen9_concern", {
    sortDesc: true,
  });
  const wtp = aggregateSingleChoice(rows, "screen10b_anchored_wtp", {
    order: WTP_ORDER,
  });
  const drivers = aggregateRanked(rows, "screen8_drivers_ranked");

  const age = aggregateSingleChoice(rows, "screen12a_age", { order: AGE_ORDER });
  const gender = aggregateSingleChoice(rows, "screen12b_gender", {
    order: GENDER_ORDER,
  });
  const household = aggregateMultiChoice(rows, "screen12c_household", {
    sortDesc: true,
  });
  const region = aggregateSingleChoice(rows, "screen12d_region", {
    order: REGION_ORDER,
  });
  const hasDemographics =
    age.length + gender.length + household.length + region.length > 0;

  return (
    <div className="space-y-4">
      <div className="grid gap-4 grid-cols-1 md:grid-cols-2">
        <Donut title="Vet recommendation reaction" data={vet} n={n} />
        <HorizontalBar title="Ingredient awareness" data={awareness} n={n} />
        <HorizontalBar title="Biggest concern" data={concerns} n={n} />
        <VerticalBar title="Anchored willingness-to-pay" data={wtp} n={n} />
        <div className="md:col-span-2">
          <WeightedRanked title="Purchase drivers (weighted top-3)" data={drivers} n={n} />
        </div>
      </div>

      {hasDemographics && (
        <>
          <h2 className="text-sm font-medium text-text-muted pt-2">
            Demographics
          </h2>
          <div className="grid gap-4 grid-cols-1 md:grid-cols-3">
            <Donut title="Age" data={age} n={n} size="sm" />
            <Donut title="Gender" data={gender} n={n} size="sm" />
            <Donut title="Region" data={region} n={n} size="sm" />
          </div>
          <div className="grid gap-4 grid-cols-1">
            <HorizontalBar title="Household composition" data={household} n={n} />
          </div>
        </>
      )}
    </div>
  );
}

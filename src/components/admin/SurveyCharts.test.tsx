import { screen } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import ConsumerSurveyCharts from "@/components/admin/ConsumerSurveyCharts";
import ProducerSurveyCharts from "@/components/admin/ProducerSurveyCharts";
import { Donut, HorizontalBar, VerticalBar, WeightedRanked } from "@/components/admin/SurveyCharts";
import type { SurveyRow } from "@/lib/exportSurveyCsv";
import { renderWithProviders } from "@/test/render";

vi.mock("recharts", () => ({
  ResponsiveContainer: ({ children }: { children: React.ReactNode }) => <div data-testid="responsive">{children}</div>,
  BarChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Bar: ({ name }: { name?: string }) => <div>{name ?? "bar"}</div>,
  XAxis: () => null,
  YAxis: () => null,
  Tooltip: () => null,
  Legend: () => null,
  PieChart: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Pie: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Cell: () => null,
}));

const rows: SurveyRow[] = [
  {
    id: "row-1",
    created_at: "2026-05-01T10:00:00.000Z",
    response_data: {
      screen7_vet_scenario: "More likely",
      screen5_awareness: ["Insect protein"],
      screen9_concern: "Price",
      screen10b_anchored_wtp: "€3–€10 more",
      screen8_drivers_ranked: { rank1: "Health", rank2: "Ingredients", rank3: "Price" },
      screen12a_age: "25–34",
      screen12b_gender: "Female",
      screen12c_household: ["Partner"],
      screen12d_region: "Europe",
      screen10_pipeline_timing: "Next 6 months",
      screen11_stance: "Exploring",
      screen11b_trigger: "Evidence",
      screen6b_supplier: ["Direct manufacturer"],
      screen7_barriers_ranked: { rank1: "Cost", rank2: "Supply", rank3: "Acceptance" },
      screen12a_company_size: "Small — 10 to 49 employees",
      screen12b_seniority: "Director",
    },
  },
];

describe("SurveyCharts", () => {
  it("renders primitive chart cards with data and empty states", () => {
    renderWithProviders(
      <>
        <VerticalBar title="Vertical" data={[{ value: "Very long label that should be shortened", count: 2 }]} n={2} />
        <HorizontalBar title="Horizontal" data={[{ value: "A", count: 1 }]} n={2} />
        <Donut title="Donut" data={[{ value: "B", count: 1 }]} n={2} />
        <WeightedRanked title="Ranked" data={[{ value: "C", weight: 6, rank1: 1, rank2: 1, rank3: 1 }]} n={2} />
        <Donut title="Empty" data={[]} n={0} />
      </>,
    );

    expect(screen.getByText("Vertical")).toBeInTheDocument();
    expect(screen.getByText("Horizontal")).toBeInTheDocument();
    expect(screen.getByText("Ranked")).toBeInTheDocument();
    expect(screen.getByText("No data yet")).toBeInTheDocument();
  });

  it("renders consumer and producer aggregate chart suites", () => {
    renderWithProviders(
      <>
        <ConsumerSurveyCharts rows={rows} />
        <ProducerSurveyCharts rows={rows} />
      </>,
    );

    expect(screen.getByText("Vet recommendation reaction")).toBeInTheDocument();
    expect(screen.getByText("Demographics")).toBeInTheDocument();
    expect(screen.getByText("Pipeline timing")).toBeInTheDocument();
    expect(screen.getByText("Barriers (weighted top-3)")).toBeInTheDocument();
  });
});

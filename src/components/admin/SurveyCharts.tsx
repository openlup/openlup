import { type ReactNode } from "react";
import {
  Bar,
  BarChart,
  Cell,
  Legend,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from "recharts";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import type { CountEntry, RankedEntry } from "@/lib/surveyAggregates";

const VOID = "#042B2C";
const TEAL = "#45BABC";
const GOLD = "#C9A84C";
const BROWN = "#8B6F47";
const GREY = "#666666";
const SAND = "#D4A574";

const SERIES_COLORS = [VOID, TEAL, GOLD, BROWN, GREY, SAND, "#5C8B8C"] as const;
const HEIGHT = 280;

function colorAt(i: number): string {
  return SERIES_COLORS[i % SERIES_COLORS.length];
}

// Truncate long labels for chart axes.
function shortLabel(s: string, max = 28): string {
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

export function ChartCard({
  title,
  n,
  empty,
  size = "md",
  children,
}: {
  title: string;
  n: number;
  empty?: boolean;
  size?: "md" | "sm";
  children: ReactNode;
}) {
  return (
    <Card className="bg-offwhite border-warm-sand">
      <CardHeader className="flex flex-row items-center justify-between space-y-0 pb-2">
        <CardTitle className="text-sm font-medium text-teal-dark/90">
          {title}
        </CardTitle>
        <span className="text-xs text-text-muted tabular-nums">n={n}</span>
      </CardHeader>
      <CardContent
        className={size === "sm" ? "h-[180px] pt-0" : "h-[280px] pt-0"}
      >
        {empty ? (
          <div className="h-full flex items-center justify-center text-xs text-text-muted">
            No data yet
          </div>
        ) : (
          children
        )}
      </CardContent>
    </Card>
  );
}

interface CountChartProps {
  title: string;
  data: CountEntry[];
  n: number;
}

export function VerticalBar({
  title,
  data,
  n,
  color = TEAL,
}: CountChartProps & { color?: string }) {
  const chartData = data.map((d) => ({ name: shortLabel(d.value), count: d.count }));
  return (
    <ChartCard title={title} n={n} empty={data.length === 0}>
      <ResponsiveContainer width="100%" height={HEIGHT - 80}>
        <BarChart data={chartData} margin={{ top: 8, right: 8, bottom: 32, left: 0 }}>
          <XAxis
            dataKey="name"
            tick={{ fill: "#FDF8F0CC", fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: "#FDF8F033" }}
            angle={-20}
            textAnchor="end"
            interval={0}
            height={56}
          />
          <YAxis
            tick={{ fill: "#FDF8F088", fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
          />
          <Tooltip
            cursor={{ fill: "#FDF8F008" }}
            contentStyle={{
              background: "#042B2C",
              border: "1px solid #FDF8F022",
              borderRadius: 8,
              color: "#FDF8F0",
              fontSize: 12,
            }}
          />
          <Bar dataKey="count" fill={color} radius={[4, 4, 0, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export function HorizontalBar({ title, data, n }: CountChartProps) {
  const chartData = data.map((d) => ({ name: shortLabel(d.value, 40), count: d.count }));
  return (
    <ChartCard title={title} n={n} empty={data.length === 0}>
      <ResponsiveContainer width="100%" height={HEIGHT - 80}>
        <BarChart
          data={chartData}
          layout="vertical"
          margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
        >
          <XAxis
            type="number"
            tick={{ fill: "#FDF8F088", fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
          />
          <YAxis
            type="category"
            dataKey="name"
            tick={{ fill: "#FDF8F0CC", fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: "#FDF8F033" }}
            width={180}
            interval={0}
          />
          <Tooltip
            cursor={{ fill: "#FDF8F008" }}
            contentStyle={{
              background: "#042B2C",
              border: "1px solid #FDF8F022",
              borderRadius: 8,
              color: "#FDF8F0",
              fontSize: 12,
            }}
          />
          <Bar dataKey="count" fill={TEAL} radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export function Donut({
  title,
  data,
  n,
  size = "md",
}: CountChartProps & { size?: "md" | "sm" }) {
  const chartData = data.map((d) => ({ name: shortLabel(d.value, 32), count: d.count }));
  const inner = size === "sm" ? 36 : 56;
  const outer = size === "sm" ? 60 : 90;
  return (
    <ChartCard title={title} n={n} size={size} empty={data.length === 0}>
      <ResponsiveContainer width="100%" height={(size === "sm" ? 180 : HEIGHT) - 80}>
        <PieChart>
          <Pie
            data={chartData}
            dataKey="count"
            nameKey="name"
            innerRadius={inner}
            outerRadius={outer}
            paddingAngle={2}
            stroke="#042B2C"
            strokeWidth={2}
          >
            {chartData.map((_, i) => (
              <Cell key={i} fill={colorAt(i)} />
            ))}
          </Pie>
          <Tooltip
            contentStyle={{
              background: "#042B2C",
              border: "1px solid #FDF8F022",
              borderRadius: 8,
              color: "#FDF8F0",
              fontSize: 12,
            }}
          />
          <Legend
            verticalAlign="bottom"
            wrapperStyle={{
              color: "#FDF8F099",
              fontSize: 11,
            }}
            iconSize={8}
          />
        </PieChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

export function WeightedRanked({
  title,
  data,
  n,
}: {
  title: string;
  data: RankedEntry[];
  n: number;
}) {
  const chartData = data.map((d) => ({
    name: shortLabel(d.value, 40),
    weight: d.weight,
    rank1: d.rank1 * 3,
    rank2: d.rank2 * 2,
    rank3: d.rank3 * 1,
  }));
  return (
    <ChartCard title={title} n={n} empty={data.length === 0}>
      <ResponsiveContainer width="100%" height={HEIGHT - 80}>
        <BarChart
          data={chartData}
          layout="vertical"
          margin={{ top: 8, right: 16, bottom: 8, left: 0 }}
        >
          <XAxis
            type="number"
            tick={{ fill: "#FDF8F088", fontSize: 11 }}
            tickLine={false}
            axisLine={false}
            allowDecimals={false}
          />
          <YAxis
            type="category"
            dataKey="name"
            tick={{ fill: "#FDF8F0CC", fontSize: 11 }}
            tickLine={false}
            axisLine={{ stroke: "#FDF8F033" }}
            width={180}
            interval={0}
          />
          <Tooltip
            cursor={{ fill: "#FDF8F008" }}
            contentStyle={{
              background: "#042B2C",
              border: "1px solid #FDF8F022",
              borderRadius: 8,
              color: "#FDF8F0",
              fontSize: 12,
            }}
            formatter={(value: number, key) => {
              if (key === "rank1") return [`${value / 3} × #1`, "Rank 1"];
              if (key === "rank2") return [`${value / 2} × #2`, "Rank 2"];
              if (key === "rank3") return [`${value} × #3`, "Rank 3"];
              return [value, key];
            }}
          />
          <Legend wrapperStyle={{ color: "#FDF8F099", fontSize: 11 }} iconSize={8} />
          <Bar dataKey="rank1" stackId="w" name="#1" fill={VOID} />
          <Bar dataKey="rank2" stackId="w" name="#2" fill={TEAL} />
          <Bar dataKey="rank3" stackId="w" name="#3" fill={GOLD} radius={[0, 4, 4, 0]} />
        </BarChart>
      </ResponsiveContainer>
    </ChartCard>
  );
}

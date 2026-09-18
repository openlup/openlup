type Row = Record<string, unknown>;

export function lineListTotalMinor(snapshot: Row): number | null {
  const quoteLine = record(snapshot.quoteLine);
  const components = quoteLine.pricingComponents;
  if (!Array.isArray(components)) return null;
  let base = 0;
  let sawBase = false;
  for (const raw of components) {
    const component = record(raw);
    if (component.componentType === "base_unit") {
      base += Number(component.amountMinor ?? 0);
      sawBase = true;
    }
  }
  return sawBase ? base : null;
}

function record(value: unknown): Row {
  return typeof value === "object" && value !== null && !Array.isArray(value) ? value as Row : {};
}

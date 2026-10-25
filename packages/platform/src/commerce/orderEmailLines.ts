import type { OrderEmailLineItem } from "./outboxOrderDraftEmailPorts.js";

export interface RawLine {
  label: string | null;
  quantity: number;
  lineSubtotalMinor: number | null;
  currency: string | null;
}

export interface OrderEmailLinePresentation<Locale extends string = string> {
  formatMoney(amountMinor: number, currency: string): string;
  genericItemLabel(locale: Locale): string;
}

export function buildItems<Locale extends string>(lines: RawLine[], locale: Locale, presentation: OrderEmailLinePresentation<Locale>): OrderEmailLineItem[] {
  return lines.map((line) => {
    const name = line.label ?? presentation.genericItemLabel(locale);
    const lineTotalLabel = line.lineSubtotalMinor !== null && line.currency !== null
      ? presentation.formatMoney(line.lineSubtotalMinor, line.currency) : "";
    return { name, quantity: line.quantity, lineTotalLabel };
  });
}

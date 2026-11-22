import { vi } from "vitest";
import { makeTaxQuoteRequest, taxDigest } from "../../../src/tax/digest.js";
import type { TaxCommitRequestV1, TaxReverseRequestV1 } from "../../../src/tax/contracts/index.js";
import type { Client, Accepted, RefundReservation, SaleReservation } from "../../../src/tax/stripe/effects.js";
import { createStripeTaxAdapter } from "../../../src/tax/stripe/index.js";
import { date, later } from "../fixtures.js";
import { detail, fakeClient, fixture, page, seconds, snapshot } from "./fixtures.js";

type Calculation = ReturnType<typeof snapshot>;
type Unit = RefundReservation["original"]["units"][number];
type Row = {
  id: string; object: string; type: string; amount: number; amount_tax: number; quantity: number;
  tax_code: string; tax_behavior: string; reference: string; reversal: null | { original_line_item: string }; livemode: boolean;
};
type Transaction = ReturnType<typeof receipt>;

function receipt(id: string, reference: string, metadata: unknown, calculation: Calculation,
  original: string | undefined, rows: Row[], shipping: TransactionShipping, posted_at: number) {
  return { id, object: "tax.transaction", reference, metadata, type: original ? "reversal" : "transaction", livemode: false,
    currency: calculation.currency, created: posted_at, posted_at, tax_date: calculation.tax_date,
    reversal: original ? { original_transaction: original } : null, shipping_cost: shipping,
    line_items: page("/v1/tax/transactions/" + id + "/line_items", rows),
  };
}
type TransactionShipping = Pick<Row, "amount" | "amount_tax" | "tax_code" | "tax_behavior"> | null;

export function lifecycleFixture(options: { single?: boolean } = {}) {
  const f = fixture();
  const { input, marketPack } = f;
  if (options.single) {
    input.money.sources = input.money.sources.slice(0, 1);
    input.money.delivery = [];
    input.lines = input.lines.slice(0, 1);
    input.delivery = [];
    input.required = input.required.slice(0, 1);
  }
  let time = date;
  let lost = false;
  let indexed = true;
  let accepted: Accepted | undefined;
  const calculations = new Map<string, Calculation>();
  const receipts = new Map<string, Transaction>();
  const references = new Map<string, string>();
  const reservations = new Map<string, SaleReservation>();
  const refunds = new Map<string, RefundReservation>();
  const quoteClient = fakeClient(input.scope);
  let make = (params: Parameters<Client["calculations"]["create"]>[0]) => snapshot(params, calculations.size,
    options.single ? { lineDetails: row => [detail(0, row.amount)] } : undefined);
  quoteClient.calculations.create.mockImplementation(async params => {
    const result = make(params);
    calculations.set(result.id, result);
    return result;
  });
  function store(transaction: Transaction) {
    receipts.set(transaction.id, transaction);
    if (indexed) references.set(transaction.reference, transaction.id);
    if (lost) throw new Error("Test transport lost the response");
    return transaction;
  }
  const transactions = {
    createFromCalculation: vi.fn<Client["transactions"]["createFromCalculation"]>(async wire => {
      const calculated = calculations.get(wire.calculation)!;
      const id = "tax_sale";
      return store(receipt(id, wire.reference, wire.metadata, calculated, undefined,
        calculated.line_items.data.map((row, index) => ({ ...row, id: "tax_line_" + index,
          object: "tax.transaction_line_item", type: "transaction", reversal: null })).reverse(),
        calculated.shipping_cost, wire.posted_at));
    }),
    createReversal: vi.fn<Client["transactions"]["createReversal"]>(async wire => {
      const sale = receipts.get(wire.original_transaction)!;
      const calculated = [...calculations.values()][0];
      const id = "tax_refund_" + receipts.size;
      const lines = wire.mode === "full" ? sale.line_items.data.map(row => ({
        reference: row.reference, original_line_item: row.id, amount: -row.amount, amount_tax: -row.amount_tax || 0,
      })) : wire.line_items ?? [];
      const shipping = wire.mode === "full" && sale.shipping_cost
        ? { amount: -sale.shipping_cost.amount || 0, amount_tax: -sale.shipping_cost.amount_tax || 0 }
        : wire.shipping_cost;
      return store(receipt(id, wire.reference, wire.metadata, calculated, sale.id, lines.map((row, index) => ({
        ...sale.line_items.data.find(line => line.id === row.original_line_item)!, ...row, id: id + "-" + index,
        type: "reversal", reversal: { original_line_item: row.original_line_item },
      })), shipping && sale.shipping_cost ? { ...sale.shipping_cost, ...shipping } : null, seconds(time)));
    }),
    retrieve: vi.fn<Client["transactions"]["retrieve"]>(async id => receipts.get(id)),
    listLineItems: vi.fn<Client["transactions"]["listLineItems"]>().mockRejectedValue(new Error("Unexpected transaction page")),
  };
  const client = { ...quoteClient, calculations: { ...quoteClient.calculations, retrieve: vi.fn(async id => calculations.get(id)) }, transactions };
  const open = () => createStripeTaxAdapter({ installationRef: "installation", client, marketPack, now: () => new Date(time),
    effects: {
      accepted: () => accepted, commit: ref => reservations.get(ref), reverse: ref => refunds.get(ref),
      findTransactionIdByReference: ref => references.get(ref),
    },
  });
  const effects = () => ({ commits: transactions.createFromCalculation.mock.calls.length,
    reversals: transactions.createReversal.mock.calls.length, providerCloses: 0 });
  function reserveCommit(request: TaxCommitRequestV1, payableMinor: number) {
    const { intent: _intent, ...body } = request;
    const value: SaleReservation = { requestDigest: taxDigest("commit", body), send: { kind: "ready", before: later },
      capture: { ref: request.captureEvidenceRef, capturedAt: request.capturedAt, currency: input.currency, payableMinor } };
    reservations.set(request.transactionRef, value);
    return value;
  }
  function reserveReverse(request: TaxReverseRequestV1, units: Unit[], payableMinor: number) {
    const { intent: _intent, ...body } = request;
    const value: RefundReservation = { requestDigest: taxDigest("reverse", body), send: { kind: "ready", before: later },
      refundEvidenceRef: request.refundEvidenceRef, original: { id: request.originalRef, scope: input.scope, currency: input.currency,
        taxDate: input.taxDate, payableMinor, refundedMinor: request.fromMinor, units } };
    refunds.set(request.reversalRef, value);
    return value;
  }
  async function quoteAndReserve(adapter = open()) {
    const request = f.request();
    const result = await adapter.quote(request);
    if (result.kind !== "final") throw new Error(JSON.stringify(result));
    const calculationRef = { scope: input.scope, ref: result.evidence.calculationRef, evidenceDigest: result.evidenceDigest };
    accepted = { request, result, closed: false };
    const commit: TaxCommitRequestV1 = { calculationRef, transactionRef: "sale-a", postedAt: time, capturedAt: time,
      captureEvidenceRef: "capture-a", intent: "apply" };
    const reservation = reserveCommit(commit, result.money.payableMinor);
    return { result, commit, reservation };
  }
  return { ...f, client, open, effects, receipts, references, reservations, refunds,
    setTime: (next: string) => { time = next; },
    setResult: (next: typeof make) => { make = next; },
    loseResponse: () => { lost = true; indexed = false; },
    accept: (value: Accepted) => { accepted = value; },
    localClose: () => { if (accepted) accepted.closed = true; },
    reserveCommit, reserveReverse, quoteAndReserve,
    probeRequest: (taxDate: string) => makeTaxQuoteRequest(f.request().key, { ...input, taxDate }),
  };
}

import { describe, expect, it } from "vitest";
import {
  compareTaxRecalculationProbe,
  localRateTable,
  makeTaxQuoteRequest,
  verifyTaxQuoteRequest,
  verifyTaxQuoteResult,
} from "@openlup/platform/tax";
import { TAX_CALCULATION_CONTRACT_VERSION, type TaxQuoteRequestV1 } from "@openlup/platform/tax/contracts";
import {
  createAvalaraHttpClient,
  createAvalaraTaxAdapter,
  taxTaggedDigest,
  type AvalaraCreateTransactionPayload,
  type AvalaraTransactionResponse,
  type FetchLike,
} from "../server/index.js";
import {
  FIXTURE_COMPANY_CODE,
  FIXTURE_FOREIGN_SCOPE,
  FIXTURE_LATER_ISO,
  FIXTURE_NOW_ISO,
  FIXTURE_SCOPE,
  FIXTURE_SENSITIVE_CANARIES,
  buildAvalaraResponse,
  buildBaseQuoteInput,
  buildCoverage,
  buildFixtureCredentials,
  buildFixtureMarketPack,
} from "./fixtures.js";

/**
 * Stage 3 Real-Flow Mount Proof (provider recipe contract, four-stage proof):
 * Uses ONLY public `@openlup/platform/tax` and `@openlup/platform/tax/contracts` exports
 * so this proof runs identically in the monorepo, after `git subtree split`, and in any
 * standalone adopter store.
 */
describe("recipes/tax/avalara — Stage 3 real-flow mount proof (+ negative controls)", () => {
  it("runs quote + multi-step discount + localRateTable parity + renewal recalculation probe + local close + positive-tax commit + taxed ReturnInvoice + clean DocVoided void", async () => {
    const httpLog: {
      readonly method: string;
      readonly path: string;
      readonly type?: string;
      readonly code?: string;
      readonly payload?: AvalaraCreateTransactionPayload;
    }[] = [];
    const docsByCode = new Map<string, AvalaraTransactionResponse>();
    let activeRate = 0.0825; // 8.25%

    const voidPathRegex = new RegExp(
      `^/api/v2/companies/${FIXTURE_COMPANY_CODE}/transactions/([^/]+)/void$`,
      "u",
    );
    const getPathRegex = new RegExp(
      `^/api/v2/companies/${FIXTURE_COMPANY_CODE}/transactions/([^/]+)$`,
      "u",
    );

    const fetchImpl: FetchLike = async (urlString, init) => {
      const url = new URL(urlString);
      const method = init?.method ?? "GET";

      const getMatch = method === "GET" ? getPathRegex.exec(url.pathname) : null;
      if (getMatch) {
        const txCode = decodeURIComponent(getMatch[1]!);
        httpLog.push({ method, path: url.pathname, type: "GetTransaction", code: txCode });
        const doc = docsByCode.get(txCode);
        if (!doc) {
          return new Response(JSON.stringify({ error: { code: "EntityNotFoundError" } }), { status: 404 });
        }
        return new Response(JSON.stringify(doc), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      const voidMatch = method === "POST" ? voidPathRegex.exec(url.pathname) : null;
      if (voidMatch) {
        const txCode = decodeURIComponent(voidMatch[1]!);
        expect(JSON.parse(init!.body as string)).toEqual({ code: "DocVoided" });
        httpLog.push({ method, path: url.pathname, type: "DocVoided", code: txCode });
        const existing = docsByCode.get(txCode);
        if (existing) {
          docsByCode.set(txCode, { ...existing, status: "Cancelled" });
        }
        return new Response(JSON.stringify({ code: txCode, status: "Cancelled" }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }

      expect(method).toBe("POST");
      expect(url.pathname).toBe("/api/v2/transactions/create");
      const payload = JSON.parse(init!.body as string) as AvalaraCreateTransactionPayload;
      httpLog.push({ method, path: url.pathname, type: payload.type, code: payload.code, payload });

      if (payload.type === "ReturnInvoice") {
        const overrideTax =
          payload.taxOverride?.type === "TaxAmount" && typeof payload.taxOverride.taxAmount === "number"
            ? payload.taxOverride.taxAmount
            : 0;
        const doc = buildAvalaraResponse({
          code: payload.code!,
          status: "Committed",
          lines: payload.lines.map((line, idx) => ({
            lineNumber: line.number,
            lineAmount: line.amount,
            taxableAmount: line.amount,
            tax: idx === 0 ? overrideTax : 0,
            details: [],
          })),
        });
        docsByCode.set(doc.code, doc);
        return new Response(JSON.stringify(doc), {
          status: 201,
          headers: { "content-type": "application/json" },
        });
      }

      const doc = buildAvalaraResponse({
        code: payload.code ?? `SO-${httpLog.length}`,
        status: payload.commit ? "Committed" : "Temporary",
        lines: payload.lines.map((line) => {
          const tax = Number((line.amount * activeRate).toFixed(2));
          return {
            lineNumber: line.number,
            lineAmount: line.amount,
            taxableAmount: line.amount,
            tax,
            details: [
              {
                jurisType: "STA",
                jurisCode: "08",
                country: "US",
                region: "CO",
                taxType: "Sales",
                rate: activeRate,
                taxableAmount: line.amount,
                tax,
                rateRuleId: 301,
              },
            ],
          };
        }),
      });
      if (payload.commit && payload.code) {
        docsByCode.set(doc.code, doc);
      }
      return new Response(JSON.stringify(doc), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    };

    const client = createAvalaraHttpClient({
      environment: "sandbox",
      fetchImpl,
      credentials: buildFixtureCredentials,
    });
    const port = createAvalaraTaxAdapter({
      client,
      companyCode: FIXTURE_COMPANY_CODE,
      scope: FIXTURE_SCOPE,
      marketPack: buildFixtureMarketPack(),
      clock: () => FIXTURE_NOW_ISO,
    });

    expect(port.contractVersion).toBe(TAX_CALCULATION_CONTRACT_VERSION);
    expect(port.capabilities().bases).toEqual(["exclusive"]);
    expect(port.capabilities().validity).toBe("probe_by_recalculation");

    // 1. Multi-step discount quote + canonical verifier
    const discountedReq = makeTaxQuoteRequest(
      "mount-discounted-1",
      buildBaseQuoteInput({
        money: {
          amountBasis: "exclusive",
          sources: [{ lineKey: "line-1", sourceOrdinal: 1, quantity: 1, unitBasisMinor: 2000 }],
          delivery: [],
          adjustments: [
            {
              adjustmentRef: "promo-10pct",
              sequence: 1,
              amountMinor: 200,
              target: { lineKeys: ["line-1"] },
            },
          ],
          fees: [],
        },
      }),
    );
    expect(verifyTaxQuoteRequest(discountedReq)).toBeUndefined();
    const discountedQuote = await port.quote(discountedReq);
    expect(discountedQuote.kind).toBe("final");
    if (discountedQuote.kind !== "final") return;
    expect(verifyTaxQuoteResult(discountedReq, discountedQuote)).toBeUndefined();
    expect(discountedQuote.money.netTotal).toBe(1800);
    expect(discountedQuote.money.taxTotal).toBe(149); // 18.00 * 0.0825 = 1.485 -> 1.49
    expect(discountedQuote.money.payableMinor).toBe(1949);

    // 2. Replaceability parity cross-check against @openlup/platform/tax localRateTable
    const localPort = localRateTable({
      scope: { adapter: "local_rate_table", adapterVersion: "1", accountRef: "local-1", mode: "test" },
      market: "US",
      currency: "USD",
      rounding: "half_up_largest_remainder",
      now: () => FIXTURE_NOW_ISO,
      calculationLifetimeMs: 86_400_000,
      validityWindowMs: 3_600_000,
      registrations: [
        {
          jurisdiction: "US-CO",
          taxKind: "sales_tax",
          state: "active",
          effective: { from: "2029-01-01T00:00:00.000Z" },
          evidenceRef: "reg-local",
        },
      ],
      rules: [
        {
          jurisdiction: "US-CO",
          taxKind: "sales_tax",
          taxClass: "standard",
          effective: { from: "2029-01-01T00:00:00.000Z" },
          ruleRef: "rule-local-co",
          legalBasisRef: "co-statute",
          kind: "rate",
          ratePercent: "8.25",
        },
      ],
    });
    const localReq = makeTaxQuoteRequest(
      "mount-local-parity",
      buildBaseQuoteInput({
        scope: localPort.capabilities().scope,
        coverage: buildCoverage(
          [
            {
              jurisdiction: "US-CO",
              taxKind: "sales_tax",
              effective: { from: "2029-01-01T00:00:00.000Z" },
              actorRef: "actor-1",
              recordedAt: "2029-01-01T00:00:00.000Z",
              status: "registered",
            },
          ],
          localPort.capabilities().scope.accountRef,
        ),
        money: discountedReq.input.money,
      }),
    );
    const localQuote = await localPort.quote(localReq);
    expect(localQuote.kind).toBe("final");
    if (localQuote.kind === "final") {
      expect(localQuote.money.payableMinor).toBe(discountedQuote.money.payableMinor);
      expect(localQuote.money.taxTotal).toBe(discountedQuote.money.taxTotal);
    }

    // 3. Renewal recalculation probe via compareTaxRecalculationProbe (unchanged -> equal, changed -> different)
    const validityRead = await port.readFiscalValidity({
      original: discountedReq,
      evidence: discountedQuote.evidence,
      evidenceDigest: discountedQuote.evidenceDigest,
      chargeAt: FIXTURE_LATER_ISO,
      current: { ...discountedReq.input, taxDate: FIXTURE_LATER_ISO },
    });
    expect(validityRead).toEqual({
      kind: "unavailable",
      code: "tax_fiscal_validity_unavailable",
      effect: "none",
    });

    const probeReq = makeTaxQuoteRequest(discountedReq.key, {
      ...discountedReq.input,
      taxDate: FIXTURE_LATER_ISO,
    });
    const probeSame = await port.quote(probeReq);
    expect(probeSame.kind).toBe("final");
    if (probeSame.kind === "final") {
      expect(compareTaxRecalculationProbe(discountedReq, discountedQuote, probeReq, probeSame)).toEqual({
        kind: "equal",
      });
    }

    activeRate = 0.09; // rate changed from 8.25% -> 9%
    const probeChanged = await port.quote(probeReq);
    expect(probeChanged.kind).toBe("final");
    if (probeChanged.kind === "final") {
      expect(compareTaxRecalculationProbe(discountedReq, discountedQuote, probeReq, probeChanged)).toEqual({
        kind: "different",
        field: "positions",
      });
    }

    // 4. Local close makes ZERO HTTP calls
    const callsBeforeClose = httpLog.length;
    const calcRef = {
      scope: FIXTURE_SCOPE,
      ref: discountedQuote.evidence.calculationRef,
      evidenceDigest: discountedQuote.evidenceDigest,
    };
    const closed = await port.closeCalculation(
      calcRef,
      { kind: "affirmatively_unused", evidenceRef: "unused-mount-1" },
      "close-mount-1",
    );
    expect(closed).toEqual({ kind: "closed", ref: calcRef, key: "close-mount-1" });
    expect(httpLog.length).toBe(callsBeforeClose);

    // 5. Positive-tax (8.25%) commit + taxed partial ReturnInvoice + remainder ReturnInvoice
    activeRate = 0.0825;
    const taxedSaleReq = makeTaxQuoteRequest(
      "mount-taxed-sale-1",
      buildBaseQuoteInput({
        money: discountedReq.input.money,
      }),
    );
    const taxedSaleQuote = await port.quote(taxedSaleReq);
    expect(taxedSaleQuote.kind).toBe("final");
    if (taxedSaleQuote.kind !== "final") return;
    expect(taxedSaleQuote.money.netTotal).toBe(1800);
    expect(taxedSaleQuote.money.taxTotal).toBe(149);
    expect(taxedSaleQuote.money.payableMinor).toBe(1949);

    const commit1 = await port.commit({
      calculationRef: {
        scope: FIXTURE_SCOPE,
        ref: taxedSaleQuote.evidence.calculationRef,
        evidenceDigest: taxedSaleQuote.evidenceDigest,
      },
      transactionRef: "tx-mount-taxed-1",
      capturedAt: FIXTURE_NOW_ISO,
      postedAt: FIXTURE_NOW_ISO,
      captureEvidenceRef: "cap-mount-taxed-1",
      intent: "apply",
    });
    expect(commit1.kind).toBe("committed");
    if (commit1.kind !== "committed") return;

    const posRef = commit1.positions[0]!.originalPositionRef;
    const revPartial = await port.reverse({
      scope: FIXTURE_SCOPE,
      originalRef: commit1.providerTransactionRef,
      reversalRef: "rev-partial-taxed-1",
      refundEvidenceRef: "ref-ev-1",
      currency: "USD",
      fromMinor: 0,
      toMinor: 975,
      mode: "lines",
      intent: "apply",
      positions: [{ originalPositionRef: posRef, netDeltaMinor: -900, taxDeltaMinor: -75, feeDeltaMinor: 0 }],
    });
    expect(revPartial.kind).toBe("reversed");

    const revRemainder = await port.reverse({
      scope: FIXTURE_SCOPE,
      originalRef: commit1.providerTransactionRef,
      reversalRef: "rev-remainder-taxed-1",
      refundEvidenceRef: "ref-ev-2",
      currency: "USD",
      fromMinor: 975,
      toMinor: 1949,
      mode: "full",
      intent: "apply",
      positions: [{ originalPositionRef: posRef, netDeltaMinor: -900, taxDeltaMinor: -74, feeDeltaMinor: 0 }],
    });
    expect(revRemainder.kind).toBe("reversed");

    const returnLogs = httpLog.filter((e) => e.type === "ReturnInvoice");
    expect(returnLogs).toHaveLength(2);
    expect(returnLogs[0]?.payload?.taxOverride).toEqual({
      type: "TaxAmount",
      taxAmount: -0.75,
      taxDate: "2030-06-15",
      reason: "Customer return",
    });
    expect(returnLogs[0]?.payload?.lines[0]?.taxCode).toBe("P0000000");
    expect(returnLogs[0]?.payload?.lines[0]?.amount).toBe(-9);
    expect(returnLogs[1]?.payload?.taxOverride).toEqual({
      type: "TaxAmount",
      taxAmount: -0.74,
      taxDate: "2030-06-15",
      reason: "Customer return",
    });

    // 6. Clean full reversal (fromMinor === 0, toMinor === payableMinor) invokes official /companies/.../void endpoint
    const saleReq2 = makeTaxQuoteRequest("mount-sale-2", buildBaseQuoteInput());
    const saleQuote2 = await port.quote(saleReq2);
    expect(saleQuote2.kind).toBe("final");
    if (saleQuote2.kind !== "final") return;
    const commit2 = await port.commit({
      calculationRef: {
        scope: FIXTURE_SCOPE,
        ref: saleQuote2.evidence.calculationRef,
        evidenceDigest: saleQuote2.evidenceDigest,
      },
      transactionRef: "tx-mount-2",
      capturedAt: FIXTURE_NOW_ISO,
      postedAt: FIXTURE_NOW_ISO,
      captureEvidenceRef: "cap-mount-2",
      intent: "apply",
    });
    expect(commit2.kind).toBe("committed");
    if (commit2.kind !== "committed") return;

    const revCleanVoid = await port.reverse({
      scope: FIXTURE_SCOPE,
      originalRef: commit2.providerTransactionRef,
      reversalRef: "rev-void-1",
      refundEvidenceRef: "ref-ev-void",
      currency: "USD",
      fromMinor: 0,
      toMinor: saleQuote2.money.payableMinor,
      mode: "full",
      intent: "apply",
      positions: [
        {
          originalPositionRef: commit2.positions[0]!.originalPositionRef,
          netDeltaMinor: -saleQuote2.money.netTotal,
          taxDeltaMinor: -saleQuote2.money.taxTotal,
          feeDeltaMinor: 0,
        },
      ],
    });
    expect(revCleanVoid.kind).toBe("reversed");
    if (revCleanVoid.kind === "reversed") {
      expect(revCleanVoid.providerReversalRef).toBe(`void:${commit2.providerTransactionRef}`);
    }
    const voidLogs = httpLog.filter((e) => e.type === "DocVoided");
    expect(voidLogs).toHaveLength(1);
    expect(voidLogs[0]?.path).toBe(
      `/api/v2/companies/${FIXTURE_COMPANY_CODE}/transactions/${commit2.providerTransactionRef}/void`,
    );

    // 7. Canary sweep across all outputs (raw, URL-encoded, Base64)
    const serialized = JSON.stringify({
      discountedQuote,
      taxedSaleQuote,
      commit1,
      revPartial,
      revRemainder,
      commit2,
      revCleanVoid,
    });
    const canaries = [
      FIXTURE_SENSITIVE_CANARIES.accountId,
      FIXTURE_SENSITIVE_CANARIES.licenseKey,
      FIXTURE_SENSITIVE_CANARIES.customerStreet,
      FIXTURE_SENSITIVE_CANARIES.customerPostal,
      Buffer.from(
        `${FIXTURE_SENSITIVE_CANARIES.accountId}:${FIXTURE_SENSITIVE_CANARIES.licenseKey}`,
        "utf8",
      ).toString("base64"),
      Buffer.from(FIXTURE_SENSITIVE_CANARIES.licenseKey, "utf8").toString("base64"),
      Buffer.from(FIXTURE_SENSITIVE_CANARIES.customerStreet, "utf8").toString("base64"),
      encodeURIComponent(FIXTURE_SENSITIVE_CANARIES.licenseKey),
      encodeURIComponent(FIXTURE_SENSITIVE_CANARIES.customerStreet),
    ];
    for (const canary of canaries) {
      expect(serialized).not.toContain(canary);
    }
  });

  it("enforces negative controls: tampered evidence refusal, zero-I/O scope/currency/inclusive refusal, and unreserved/closed/outage commit safety", async () => {
    let networkCalls = 0;
    let shouldFailCommit = false;

    const client = createAvalaraHttpClient({
      environment: "sandbox",
      credentials: buildFixtureCredentials,
      fetchImpl: async (_url, init) => {
        networkCalls += 1;
        const payload = JSON.parse(init!.body as string) as AvalaraCreateTransactionPayload;
        if (payload.type === "SalesInvoice" && shouldFailCommit) {
          return new Response(JSON.stringify({ error: { code: "ServiceUnavailable" } }), { status: 503 });
        }
        return new Response(
          JSON.stringify(
            buildAvalaraResponse({
              code: payload.code ?? "SO-NC",
              status: payload.commit ? "Committed" : "Temporary",
              lines: payload.lines.map((l) => ({
                lineNumber: l.number,
                lineAmount: l.amount,
                taxableAmount: l.amount,
                tax: 0,
                details: [
                  {
                    jurisType: "STA",
                    jurisCode: "08",
                    country: "US",
                    region: "CO",
                    taxType: "Sales",
                    rate: 0,
                    taxableAmount: l.amount,
                    tax: 0,
                  },
                ],
              })),
            }),
          ),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      },
    });

    let allowReservation = false;
    const port = createAvalaraTaxAdapter({
      client,
      companyCode: FIXTURE_COMPANY_CODE,
      scope: FIXTURE_SCOPE,
      marketPack: buildFixtureMarketPack(),
      clock: () => FIXTURE_NOW_ISO,
      hasCommitReservation: () => allowReservation,
    });

    // NC1: Scope mismatch, unsupported currency, and inclusive amountBasis refuse at ZERO I/O
    const wrongScopeReq = makeTaxQuoteRequest(
      "nc-wrong-scope",
      buildBaseQuoteInput({
        scope: FIXTURE_FOREIGN_SCOPE,
        coverage: buildCoverage(
          [
            {
              jurisdiction: "US-CO",
              taxKind: "sales_tax",
              effective: { from: "2029-01-01T00:00:00.000Z" },
              actorRef: "actor-1",
              recordedAt: "2029-01-01T00:00:00.000Z",
              status: "registered",
            },
          ],
          FIXTURE_FOREIGN_SCOPE.accountRef,
        ),
      }),
    );
    expect(await port.quote(wrongScopeReq)).toMatchObject({ kind: "refused", code: "tax_scope_mismatch" });

    const wrongCurrencyReq = makeTaxQuoteRequest(
      "nc-wrong-currency",
      buildBaseQuoteInput({ currency: "EUR" }),
    );
    expect(await port.quote(wrongCurrencyReq)).toMatchObject({ kind: "refused", code: "tax_scope_mismatch" });

    const baseInclusiveReq = makeTaxQuoteRequest("nc-inclusive", buildBaseQuoteInput());
    const inclusivePayload = {
      ...baseInclusiveReq.input,
      money: {
        ...baseInclusiveReq.input.money,
        amountBasis: "inclusive" as "exclusive",
      },
    };
    const inclusiveReq: TaxQuoteRequestV1 = {
      key: baseInclusiveReq.key,
      input: inclusivePayload,
      inputDigest: taxTaggedDigest("platform.tax.input.v1", inclusivePayload),
    };
    const inclusiveResult = await port.quote(inclusiveReq);
    expect(inclusiveResult).toMatchObject({
      kind: "refused",
      code: "tax_scope_mismatch",
      field: "/input/money/amountBasis",
    });
    expect(networkCalls).toBe(0);

    // NC2: Tampered evidence & invalid probe rejected by platform verifiers
    const goodReq = makeTaxQuoteRequest("nc-good", buildBaseQuoteInput());
    const goodQuote = await port.quote(goodReq);
    expect(goodQuote.kind).toBe("final");
    if (goodQuote.kind !== "final") return;

    const tamperedQuote = {
      ...goodQuote,
      evidence: { ...goodQuote.evidence, fiscalDigest: "0".repeat(64) },
    };
    expect(verifyTaxQuoteResult(goodReq, tamperedQuote)?.kind).toBe("refused");

    const sameDateProbe = makeTaxQuoteRequest(goodReq.key, { ...goodReq.input });
    expect(compareTaxRecalculationProbe(goodReq, goodQuote, sameDateProbe, goodQuote)).toMatchObject({
      kind: "refused",
      code: "tax_calculation_unusable",
    });

    // NC3: Unreserved commit refuses at 0 I/O; closed calculation refuses at 0 I/O; 503 during commit returns effect:"unknown"
    const callsBeforeNc3 = networkCalls;
    const unreserved = await port.commit({
      calculationRef: {
        scope: FIXTURE_SCOPE,
        ref: goodQuote.evidence.calculationRef,
        evidenceDigest: goodQuote.evidenceDigest,
      },
      transactionRef: "tx-unreserved",
      capturedAt: FIXTURE_NOW_ISO,
      postedAt: FIXTURE_NOW_ISO,
      captureEvidenceRef: "cap-none",
      intent: "apply",
    });
    expect(unreserved).toMatchObject({ kind: "refused", code: "tax_calculation_unusable" });
    expect(networkCalls).toBe(callsBeforeNc3);

    allowReservation = true;
    await port.closeCalculation(
      {
        scope: FIXTURE_SCOPE,
        ref: goodQuote.evidence.calculationRef,
        evidenceDigest: goodQuote.evidenceDigest,
      },
      { kind: "affirmatively_unused", evidenceRef: "unused-nc" },
      "close-nc",
    );
    const commitClosed = await port.commit({
      calculationRef: {
        scope: FIXTURE_SCOPE,
        ref: goodQuote.evidence.calculationRef,
        evidenceDigest: goodQuote.evidenceDigest,
      },
      transactionRef: "tx-closed",
      capturedAt: FIXTURE_NOW_ISO,
      postedAt: FIXTURE_NOW_ISO,
      captureEvidenceRef: "cap-closed",
      intent: "apply",
    });
    expect(commitClosed).toMatchObject({ kind: "refused", code: "tax_calculation_closed" });
    expect(networkCalls).toBe(callsBeforeNc3);

    // 503 during SalesInvoice commit MUST return effect:"unknown" (never "none")
    const freshReq = makeTaxQuoteRequest("nc-fresh", buildBaseQuoteInput());
    const freshQuote = await port.quote(freshReq);
    expect(freshQuote.kind).toBe("final");
    if (freshQuote.kind !== "final") return;
    shouldFailCommit = true;
    const outageCommit = await port.commit({
      calculationRef: {
        scope: FIXTURE_SCOPE,
        ref: freshQuote.evidence.calculationRef,
        evidenceDigest: freshQuote.evidenceDigest,
      },
      transactionRef: "tx-outage",
      capturedAt: FIXTURE_NOW_ISO,
      postedAt: FIXTURE_NOW_ISO,
      captureEvidenceRef: "cap-outage",
      intent: "apply",
    });
    expect(outageCommit).toEqual({
      kind: "unavailable",
      code: "tax_adapter_unavailable",
      effect: "unknown",
    });
  });
});

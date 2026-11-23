import type { TaxCoverageV1 } from "@openlup/platform/tax/contracts";

export function coverageCorpus(from: string, until: string) {
  const base: TaxCoverageV1 = { schemaVersion: 1, accountRef: "account-a", revision: "revision-a", declarations: [] };
  const registered = { jurisdiction: "district-a", taxKind: "sale", status: "registered", actorRef: "operator-a",
    recordedAt: from, effective: { from } } as const;
  const withRows = (...declarations: unknown[]) => ({ ...base, declarations });
  const acknowledged = { ...registered, status: "not_registered_acknowledged", acknowledgementRef: "decision-1" };
  const supplementary = { ...registered, jurisdiction: "🌱" };
  const bmp = { ...registered, jurisdiction: "\uE000" };
  const bytes = (input: unknown) => Buffer.byteLength(JSON.stringify(input), "utf8");
  const sized = (size: number) => {
    const row = (index: number): TaxCoverageV1["declarations"][number] =>
      ({ ...registered, jurisdiction: `district-${String(index).padStart(5, "0")}` });
    const length = Math.floor((size - bytes(base) + 1) / (bytes(row(0)) + 1));
    const value = { ...base, declarations: Array.from({ length }, (_, index) => row(index)) };
    value.declarations[0] = { ...row(0), actorRef: registered.actorRef + "x".repeat(size - bytes(value)) };
    return value;
  };
  return [
    { value: base },
    { value: withRows(acknowledged) },
    { value: withRows({ ...registered, effective: { from: until } }, { ...registered, effective: { from, until } }) },
    { value: withRows({ ...registered, taxKind: "fee" }, registered) },
    { value: { ...base, accountRef: "🌱".repeat(128) } },
    { value: withRows({ ...registered, effective: { from: "0000-02-29T00:00:00.000Z" } }) },
    { value: sized(1_048_576), byteLength: 1_048_576 },
    { value: sized(1_048_577), byteLength: 1_048_577, field: "" },
    { value: null, field: "" },
    { value: { ...base, unexpected: true }, field: "" },
    { value: { ...base, schemaVersion: "1" }, field: "/schemaVersion" },
    { value: { ...base, accountRef: "🌱".repeat(129) }, field: "/accountRef" },
    { value: { ...base, declarations: {} }, field: "/declarations" },
    { value: withRows({ ...registered, actorRef: "" }), field: "/declarations/0/actorRef" },
    { value: withRows({ ...registered, status: "unknown" }), field: "/declarations/0/status" },
    { value: withRows({ ...registered, acknowledgementRef: "unexpected" }), field: "/declarations/0" },
    { value: withRows({ ...registered, status: "not_registered_acknowledged" }), field: "/declarations/0/acknowledgementRef" },
    { value: withRows({ ...registered, effective: { from, until: from } }), field: "/declarations/0/effective/until" },
    { value: withRows({ ...registered, effective: { from: "2040-02-30T00:00:00.000Z" } }), field: "/declarations/0/effective/from" },
    { value: withRows({ ...registered, effective: { from: until } }, registered), field: "/declarations/0/effective" },
    { value: withRows(registered, acknowledged), field: "/declarations/1/effective" },
    { value: withRows(bmp, bmp, supplementary, supplementary), field: "/declarations/3/effective" },
  ];
}

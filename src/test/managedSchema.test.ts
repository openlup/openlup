import { describe, expect, it } from "vitest";
import { declaredTableGrants, readManagedTable } from "./managedSchema";

const sql = `CREATE TABLE public.ledger (
    id uuid NOT NULL
);
CREATE TABLE public.ledger_other (
    private_payload jsonb
);
ALTER TABLE public.ledger ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON TABLE public.ledger TO authenticated;
GRANT ALL ON TABLE public.ledger_other TO anon;
CREATE POLICY ledger_owner ON public.ledger FOR SELECT USING (true);`;

describe("published schema object isolation", () => {
  it("does not borrow another object's fields or privileges", () => {
    const ledger = readManagedTable(sql, "ledger");
    expect(ledger).toContain("ENABLE ROW LEVEL SECURITY");
    expect(ledger).toContain("CREATE POLICY ledger_owner");
    expect(ledger).not.toContain("private_payload");
    expect(declaredTableGrants(ledger, "anon")).toEqual([]);
    expect(declaredTableGrants(ledger, "authenticated")).toEqual(["SELECT"]);
  });
  it("fails closed for absent objects and non-identifiers", () => {
    expect(() => readManagedTable(sql, "missing")).toThrow("no public.missing");
    expect(() => readManagedTable(sql, "ledger|ledger_other")).toThrow("invalid SQL object name");
  });
  it("reflects a newly introduced browser grant", () => {
    const ledger = readManagedTable(sql + "\nGRANT INSERT ON TABLE public.ledger TO anon;", "ledger");
    expect(declaredTableGrants(ledger, "anon")).toEqual(["INSERT"]);
  });
  it("applies revocations in order rather than accepting an obsolete grant", () => {
    const ledger = readManagedTable(sql + "\nREVOKE ALL ON TABLE public.ledger FROM authenticated;\nGRANT UPDATE ON TABLE public.ledger TO authenticated;", "ledger");
    expect(declaredTableGrants(ledger, "authenticated")).toEqual(["UPDATE"]);
  });
});

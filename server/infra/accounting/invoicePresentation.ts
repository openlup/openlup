// How an issued document reads, as opposed to what it charges. The mapper next
// door owns field names and money; this owns the unit column and the notes.

const DEFAULT_QUANTITY_UNIT = "szt.";
const ORDER_REFERENCE_NOTE_LABEL = "Numer zamówienia";
const KSEF_NOTE_MAX_LENGTH = 256;

// A position with no unit prints "(brak)" in the j.m. column. The neutral port
// carries no unit for these lines yet, so this reference adapter supplies the
// locale default its market expects; a line that names its own unit wins.
export function quantityUnit(line: { quantityUnit?: string }): string {
  return line.quantityUnit?.trim() || DEFAULT_QUANTITY_UNIT;
}

// Printed as "Uwagi" and submitted to KSeF as DodatkowyOpis (Klucz/Wartosc),
// which is why the order reference is a labelled record rather than one joined
// string: both halves carry a 256-character schema limit.
export function documentNotes(orderRef: string): Array<{ kind: string; content: string }> {
  return [{
    kind: ORDER_REFERENCE_NOTE_LABEL,
    content: orderRef.slice(0, KSEF_NOTE_MAX_LENGTH),
  }];
}

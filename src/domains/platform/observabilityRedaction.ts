// Single canonical redaction primitive for observability evidence/evaluators.
// Provider references (payment + attempt ids) must never reach an
// operator surface verbatim — collapse any present value to a fixed marker so a
// future tightening of the redaction policy happens in exactly one place and
// cannot silently leak from a forked copy.
export function maskProviderReference(value: string | null | undefined): string | null {
  return value ? "redacted_provider_reference" : null;
}

/** @experimental Informational catalogue entries owned by communications. */
export const communicationsSettingBoundaries: readonly (readonly [key: string, kind: "cap" | "invariant", goal: string, reason: string])[] = [
  ["additionalLocales", "cap", "Use additional languages for OpenLup communications and identity.", "Package contracts restrict the supported locale vocabulary."],
  ["accountConsentPurposes", "cap", "Define account consent purposes and copy revisions.", "The native account consent path uses fixed purposes and a fixed copy revision."],
  ["messageDateFormatting", "cap", "Use consistent date formatting and time zones in UI and mail.", "The starter displays several recorded timestamps directly."],
];

// Cross-domain accounting read contracts. Provider/runtime mutation contracts
// remain in invoiceContracts.ts and ports.ts.
export { resolveAccountingDocumentHistory } from "./accountingDocumentHistory.js";
export type {
  AccountingDocumentArtifact,
  AccountingDocumentEmailState,
  AccountingDocumentHistory,
  AccountingDocumentHistoryEntry,
  AccountingDocumentHistoryRow,
  AccountingDocumentRole,
} from "./accountingDocumentHistory.js";

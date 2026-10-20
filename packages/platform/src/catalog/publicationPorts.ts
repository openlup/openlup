import type {
  CatalogHeadRef, CatalogHistoryResult, CatalogPublicationReadResult,
  CatalogPublicationReceipt, CatalogPublicationReceiptResult,
  CatalogPublicationRefusal, CatalogPublishCommand,
} from "./contracts/lifecycle.js";

declare const verifiedCatalogPublisher: unique symbol;
/** Server authorization result. P1 exposes no constructor or actor-string conversion. */
export interface VerifiedCatalogPublisher {
  readonly [verifiedCatalogPublisher]: true;
}

export interface CatalogValidationPort {
  validate(candidateRef: string): Promise<{
    candidateDigest: string;
    issues: readonly { code: string; path: string }[];
  }>;
}

/** No default binding: missing authority is unsupported; configured outage is dependency_unavailable. */
export interface CatalogPublicationReadPort {
  current(productId: string): Promise<CatalogPublicationReadResult>;
  readback(head: CatalogHeadRef): Promise<CatalogPublicationReadResult>;
  receipt(scope: { productId: string; commandKey: string }): Promise<CatalogPublicationReceiptResult>;
  /** Null starts a bounded history page; cursors retain the authority's stable ordering. */
  history(productId: string, cursor: string | null): Promise<CatalogHistoryResult>;
}

/** Types only: proposal submission does not implement publication or lifecycle writes. */
export interface CatalogPublicationPort {
  publish(command: CatalogPublishCommand, actor: VerifiedCatalogPublisher): Promise<
    | { outcome: "committed" | "replayed"; receipt: CatalogPublicationReceipt }
    | CatalogPublicationRefusal
  >;
}

/** Describes a host's actual support; exporting ports supplies no capabilities. */
export interface CatalogCapabilityDescriptor {
  read: boolean;
  draft: boolean;
  publicationRead: boolean;
  publish: boolean;
  lifecycleWrite: boolean;
}

export type PrelaunchAcquisitionListRequest = { view: "prelaunch_acquisition_v1"; cursor?: string | undefined; limit: number };
export type PrelaunchAcquisitionDetailRequest = { sourceRef: string };
export type PrelaunchAcquisitionLead = {
  sourceRef: string;
  contactRef: string;
  sourceKind: "tester_application";
  consent: { consentVersion: string; policyVersion: string; recordedAt: string; locale: "en" | "pl"; sourcePath: "/tester-application" };
  addressReference: { source: string; reference: string; revision: string; provenance: string } | null;
  state: "submitted" | "approved" | "active" | "rejected" | "withdrawn";
  version: number;
  createdAt: string;
  updatedAt: string;
};
export type PrelaunchAcquisitionListResponse = { contractVersion: "prelaunch_acquisition_v1"; leads: PrelaunchAcquisitionLead[]; nextCursor: string | null };
export type PrelaunchAcquisitionDetailResponse = { contractVersion: "prelaunch_acquisition_v1"; lead: PrelaunchAcquisitionLead };

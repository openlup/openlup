export type Manifest = { private?: boolean };

export type RepositoryPolicy = {
  schemaVersion?: number;
  repository?: {
    packageName?: string;
    currentPhase?: string;
    packageVisibility?: string;
    activation?: {
      target?: string;
      separateRepositoryActivation?: string;
      publicSourceOpening?: string;
    };
  };
  localGovernance?: {
    pullRequestsRequired?: boolean;
    requiredStatusChecks?: string[];
    mergeMethods?: { squash?: boolean; mergeCommit?: boolean; rebase?: boolean };
    allowForcePushes?: boolean;
    allowDeletions?: boolean;
    bypassActors?: unknown[];
  };
  ownership?: {
    codeOwnerReviewRequired?: boolean;
    rationale?: string;
    codeOwners?: string[];
  };
  security?: {
    scanning?: {
      required?: boolean;
      workflowCheck?: string;
      tool?: string;
      pinnedVersion?: string;
      checksumVerified?: boolean;
    };
    dependabot?: { required?: boolean; ecosystems?: string[] };
  };
  localProofToolchain?: { node?: string; npm?: string };
};

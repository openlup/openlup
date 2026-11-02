import type { AgentReason } from "./contracts/rpcErrors.js";

export class DomainRpcError extends Error {
  constructor(
    readonly sqlstate: string | undefined,
    readonly pgMessage: string,
    /** Optional named token a RAISE carries (e.g. `publish_requires_human`). */
    readonly raiseToken?: AgentReason,
  ) {
    super(pgMessage);
    this.name = "DomainRpcError";
  }
}

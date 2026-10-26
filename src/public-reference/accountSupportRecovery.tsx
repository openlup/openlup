import type { LinkThenSubscriptionResult, OperatorAuthorityCapabilities } from "@openlup/platform/account-support/contracts";

/** Reference-only status surface; host copy/confirmation/transport remain injected. */
export function AccountSupportRecoveryStatus(props: {
  capabilities: OperatorAuthorityCapabilities;
  action: keyof Omit<OperatorAuthorityCapabilities, "graph">;
  result?: LinkThenSubscriptionResult;
}) {
  const capability = props.capabilities[props.action];
  if (capability.supported === false) return <p role="status">{capability.refusalCode}</p>;
  if (props.result?.outcome === "partial") {
    return <p role="status">Account linked. Subscription action incomplete.
      {props.result.subscription && "refusalCode" in props.result.subscription ? ` ${props.result.subscription.refusalCode}` : ""}
    </p>;
  }
  if (props.result?.outcome === "link_refused" && "refusalCode" in props.result.link) {
    return <p role="status">{props.result.link.refusalCode}</p>;
  }
  return <p role="status">{props.result?.outcome === "completed" ? "Account linked. Subscription action completed." : "Ready"}</p>;
}

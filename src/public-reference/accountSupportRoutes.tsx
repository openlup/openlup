import type { ReactElement } from "react";
import { Route, Routes } from "react-router-dom";

/** Host-supplied elements retain separate customer/operator auth and clients.
 * Configured recovery/purchase elements receive their selected owner clients
 * from the host; rendering this recipe grants no checkout authority.
 */
export function AccountSupportRoutes(props: {
  account: ReactElement;
  customer360: ReactElement;
  commands: ReactElement;
  recovery: ReactElement;
  configuredPurchase?: ReactElement;
  paths: { account: string; customer360: string; commands: string; recovery: string; configuredPurchase?: string };
}) {
  return <Routes>
    <Route path={props.paths.account} element={props.account} />
    <Route path={props.paths.commands} element={props.commands} />
    <Route path={props.paths.customer360} element={props.customer360} />
    <Route path={props.paths.recovery} element={props.recovery} />
    {props.paths.configuredPurchase && props.configuredPurchase &&
      <Route path={props.paths.configuredPurchase} element={props.configuredPurchase} />}
  </Routes>;
}

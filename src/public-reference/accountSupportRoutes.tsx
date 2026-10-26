import type { ReactElement } from "react";
import { Route, Routes } from "react-router-dom";

/** Host-supplied elements retain separate customer/operator auth and clients.
 * Importing or rendering this recipe does not select checkout continuation.
 */
export function AccountSupportRoutes(props: {
  account: ReactElement;
  customer360: ReactElement;
  commands: ReactElement;
  recovery: ReactElement;
  paths: { account: string; customer360: string; commands: string; recovery: string };
}) {
  return <Routes>
    <Route path={props.paths.account} element={props.account} />
    <Route path={props.paths.commands} element={props.commands} />
    <Route path={props.paths.customer360} element={props.customer360} />
    <Route path={props.paths.recovery} element={props.recovery} />
  </Routes>;
}

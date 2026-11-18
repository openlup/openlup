// Keep the BFF route table in the tooling compiler's import graph. The
// published-tree typecheck runs tsconfig.node.json alongside tsconfig.api.json.
import { routes } from "../api/bff/[...path].js";

export const bffRouteTableRouteCount: number = routes.length;

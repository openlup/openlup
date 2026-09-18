// Statically imports the BFF route table so `npm run typecheck:node` checks the
// whole server graph under this program's rules (`strict: false,
// strictNullChecks: false`). In that mode a falsy discriminant guard
// (`if (!result.ok)`) narrows only the truthy branch, so server code must use
// literal equality (`if (result.ok === false)`) instead. Without this import
// nothing under scripts/ reaches the route table and the divergence between
// tsconfig.node.json and tsconfig.api.json stays invisible until a script
// imports it — this file keeps any regression red in `typecheck:node`.
import { routes } from "../api/bff/[...path].js";

export const bffRouteTableRouteCount: number = routes.length;

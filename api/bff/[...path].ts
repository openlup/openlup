import type { VercelRequest, VercelResponse } from "../../server/_lib/types/vercel.js";
import { dispatch, type RouteEntry } from "../../server/runtime/bffDispatch.js";

/** The bounded public-reference runtime advertises no BFF capability. */
export const routes: RouteEntry[] = [];
export default function bffRouter(req: VercelRequest, res: VercelResponse): Promise<unknown> { return dispatch(routes, req, res); }

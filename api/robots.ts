import type { VercelRequest, VercelResponse } from "../server/_lib/types/vercel.js";
import { ROBOTS_CONTENT_TYPE, robotsTxtForHost } from "../server/shared/robots.js";

export default function robotsHandler(req: VercelRequest, res: VercelResponse): void {
  res.setHeader("Content-Type", ROBOTS_CONTENT_TYPE);
  res.setHeader("Cache-Control", "public, max-age=0, s-maxage=300, stale-while-revalidate=3600");
  res.status(200).send(robotsTxtForHost(req.headers?.host));
}

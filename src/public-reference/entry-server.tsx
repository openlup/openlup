import { renderToString } from "react-dom/server";

import { PublicReferenceApp } from "./App";

/** Browser-free renderer consumed only by the public-reference prerenderer. */
export function renderRoute(pathname: string): string {
  return renderToString(<PublicReferenceApp pathname={pathname} />);
}

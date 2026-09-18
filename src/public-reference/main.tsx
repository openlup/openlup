import { hydrateRoot } from "react-dom/client";

import { PublicReferenceApp } from "./App";

const root = document.getElementById("root");

if (!root) throw new Error("Public reference root is missing");

hydrateRoot(root, <PublicReferenceApp pathname={window.location.pathname} />);

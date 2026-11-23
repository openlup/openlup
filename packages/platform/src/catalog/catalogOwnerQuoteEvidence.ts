import { createHash } from "node:crypto";
import { canonicalCatalogDraftJson } from "./contracts/draft.js";

export const evidenceRef = (dialect: "price.v1" | "policy.v1", value: unknown) =>
  `${dialect}:${createHash("sha256").update(canonicalCatalogDraftJson([dialect, value]), "utf8").digest("hex")}`;

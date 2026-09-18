import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  CATALOG_CONTRACT_VERSION,
  catalogAllergenListResponseSchema,
  catalogProductListResponseSchema,
  catalogProductReadResponseSchema,
  catalogProductSlugSchema,
} from "../../../src/domains/catalog/contracts.js";
import type { CatalogReadPort } from "../../../src/domains/catalog/ports.js";

const PUBLIC_METADATA_CACHE_CONTROL = "public, s-maxage=300, stale-while-revalidate=86400";
const PUBLIC_MONEY_CACHE_CONTROL = "public, max-age=0, s-maxage=5, must-revalidate";

export interface CatalogHandlerDeps {
  readPort: CatalogReadPort;
}

export function createCatalogProductsListHandler({ readPort }: CatalogHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"]);
      return;
    }

    try {
      const result = catalogProductListResponseSchema.safeParse({
        contractVersion: CATALOG_CONTRACT_VERSION,
        products: await readPort.listProducts(),
      });

      if (!result.success) {
        sendBffError(res, "INVALID_RESPONSE", "Catalog product list returned invalid response");
        return;
      }

      sendBffSuccess(
        res,
        result.data,
        {
          contractVersion: CATALOG_CONTRACT_VERSION,
        },
        {
          cacheControl: PUBLIC_MONEY_CACHE_CONTROL,
        },
      );
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Catalog product list failed");
    }
  };
}

export function createCatalogProductReadHandler({ readPort }: CatalogHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"]);
      return;
    }

    const slug = readSingleQueryValue(req.query.slug);
    if (!slug) {
      sendBffError(res, "BAD_REQUEST", "Catalog product slug is required");
      return;
    }

    const parsedSlug = catalogProductSlugSchema.safeParse(slug);
    if (!parsedSlug.success) {
      sendBffError(res, "NOT_FOUND", "Catalog product not found");
      return;
    }

    try {
      const product = await readPort.getProductBySlug(parsedSlug.data);
      if (!product) {
        sendBffError(res, "NOT_FOUND", "Catalog product not found");
        return;
      }

      const result = catalogProductReadResponseSchema.safeParse({
        contractVersion: CATALOG_CONTRACT_VERSION,
        product,
      });

      if (!result.success) {
        sendBffError(res, "INVALID_RESPONSE", "Catalog product returned invalid response");
        return;
      }

      sendBffSuccess(
        res,
        result.data,
        {
          contractVersion: CATALOG_CONTRACT_VERSION,
        },
        {
          cacheControl: PUBLIC_MONEY_CACHE_CONTROL,
        },
      );
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Catalog product read failed");
    }
  };
}

export function createCatalogAllergensListHandler({ readPort }: CatalogHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"]);
      return;
    }

    try {
      const result = catalogAllergenListResponseSchema.safeParse({
        contractVersion: CATALOG_CONTRACT_VERSION,
        allergens: await readPort.listAllergens(),
      });

      if (!result.success) {
        sendBffError(res, "INVALID_RESPONSE", "Catalog allergens returned invalid response");
        return;
      }

      sendBffSuccess(
        res,
        result.data,
        {
          contractVersion: CATALOG_CONTRACT_VERSION,
        },
        {
          cacheControl: PUBLIC_METADATA_CACHE_CONTROL,
        },
      );
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Catalog allergens read failed");
    }
  };
}

function readSingleQueryValue(value: string | string[] | undefined): string | null {
  if (typeof value === "string") return value;
  return null;
}

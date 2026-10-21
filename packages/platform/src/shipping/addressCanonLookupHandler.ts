import type { HttpRequest, HttpResponse } from "../http/index.js";
import type { BffResponder } from "../bff/index.js";
import type { AddressCanonLookupDeps } from "./addressPorts.js";
import type { AddressLookupSchemas } from "./addressSchemas.js";

export function createAddressCanonPostalCodeHandler({ lookupPort }: AddressCanonLookupDeps, schemas: AddressLookupSchemas, responder: BffResponder) {
  const { addressCanonPostalCodeLookupRequestSchema, addressCanonPostalCodeLookupResponseSchema } = schemas;
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = responder;
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);

    const parsed = addressCanonPostalCodeLookupRequestSchema.safeParse({
      postalCode: readQuery(req, "postalCode"),
      limit: readLimit(req, 10),
    });
    if (!parsed.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid address canon postal-code request", {
        details: parsed.error.flatten(),
      });
      return;
    }

    try {
      const result = await lookupPort.lookupPostalCode(parsed.data);
      const response = addressCanonPostalCodeLookupResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Address canon postal-code lookup failed validation");
        return;
      }
      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Address canon postal-code lookup failed");
    }
  };
}

export function createAddressCanonLocalitiesHandler({ lookupPort }: AddressCanonLookupDeps, schemas: AddressLookupSchemas, responder: BffResponder) {
  const { addressCanonLocalitiesLookupRequestSchema, addressCanonLocalitiesLookupResponseSchema } = schemas;
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = responder;
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);

    const parsed = addressCanonLocalitiesLookupRequestSchema.safeParse({
      q: readQuery(req, "q"),
      limit: readLimit(req, 10),
    });
    if (!parsed.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid address canon localities request", {
        details: parsed.error.flatten(),
      });
      return;
    }

    try {
      const result = await lookupPort.searchLocalities(parsed.data);
      const response = addressCanonLocalitiesLookupResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Address canon localities lookup failed validation");
        return;
      }
      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Address canon localities lookup failed");
    }
  };
}

export function createAddressCanonStreetsHandler({ lookupPort }: AddressCanonLookupDeps, schemas: AddressLookupSchemas, responder: BffResponder) {
  const { addressCanonStreetsLookupRequestSchema, addressCanonStreetsLookupResponseSchema } = schemas;
  const { sendBffError, sendBffSuccess, sendMethodNotAllowed } = responder;
  return async function handler(req: HttpRequest, res: HttpResponse): Promise<void> {
    if (req.method !== "GET") return sendMethodNotAllowed(res, ["GET"]);

    const parsed = addressCanonStreetsLookupRequestSchema.safeParse({
      localityId: readQuery(req, "localityId"),
      q: readOptionalQuery(req, "q"),
      limit: readLimit(req, 20),
    });
    if (!parsed.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid address canon streets request", {
        details: parsed.error.flatten(),
      });
      return;
    }

    try {
      const result = await lookupPort.listStreets(parsed.data);
      const response = addressCanonStreetsLookupResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Address canon streets lookup failed validation");
        return;
      }
      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Address canon streets lookup failed");
    }
  };
}

function readQuery(req: HttpRequest, key: string): string | undefined {
  const value = req.query?.[key];
  return Array.isArray(value) ? value[0] : value;
}

function readOptionalQuery(req: HttpRequest, key: string): string | undefined {
  const value = readQuery(req, key)?.trim();
  return value || undefined;
}

function readLimit(req: HttpRequest, fallback: number): number {
  const raw = readQuery(req, "limit");
  if (!raw) return fallback;
  return Number(raw);
}

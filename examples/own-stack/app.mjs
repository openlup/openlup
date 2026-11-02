import { createHash, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import {
  createCatalogDraftHandler, createCatalogProductTypeRegistry, createPostgresCatalogDraftStore,
} from "@openlup/platform/catalog";
import { createPostgresDataGateway } from "@openlup/platform/data";

// Application-owned authentication: one pre-provisioned local operator session.
// A real host replaces this verifier with its existing session or issuer verifier.
export function createApplication({ pool, operatorToken }) {
  if (!/^[a-f0-9]{64}$/u.test(operatorToken ?? "")) throw new Error("operator_token_must_be_32_random_bytes_hex");
  const digest = (value) => createHash("sha256").update(value).digest();
  const expected = digest(`Bearer ${operatorToken}`);
  const authenticate = (request) => {
    const supplied = request.headers.authorization;
    return typeof supplied === "string" && timingSafeEqual(digest(supplied), expected)
      ? { actorId: "app:catalog-editor" } : null;
  };

  // The supplied restricted login can SET ROLE service_role; it is not the installer.
  const data = createPostgresDataGateway({ connectionString: "" }, { poolFactory: () => pool });
  const store = {
    apply: (input) => data.asService((db) => createPostgresCatalogDraftStore(db).apply(input)),
    get: (query, actorId) => data.asService((db) => createPostgresCatalogDraftStore(db).get(query, actorId)),
    list: (query, actorId) => data.asService((db) => createPostgresCatalogDraftStore(db).list(query, actorId)),
  };
  const registry = createCatalogProductTypeRegistry([{
    key: "example:item", version: 1, dimensions: [],
    units: [{ code: "example:each", dimension: "count", integral: true }],
    netContentUnits: ["example:each"],
    validateContent: (content) => typeof content?.title === "string" && content.title.trim()
      ? [] : [{ path: "title", code: "title_required" }],
  }]);
  const drafts = createCatalogDraftHandler({
    store, registry, authorizeOperator: async ({ operator }) => operator,
  });

  // This application's route table and response convention; no OpenLup host/starter.
  return createServer(async (request, response) => {
    const send = (status, value) => {
      response.writeHead(status, { "content-type": "application/json", "cache-control": "no-store" });
      response.end(JSON.stringify(value));
    };
    try {
      if (request.url !== "/drafts") return send(404, { reason: "route_not_found" });
      if (request.method !== "POST") {
        response.setHeader("allow", "POST");
        return send(405, { reason: "method_not_allowed" });
      }
      const operator = authenticate(request);
      if (!operator) {
        request.resume();
        response.setHeader("www-authenticate", "Bearer");
        return send(401, { reason: "operator_required" });
      }
      if (request.headers["content-type"]?.split(";")[0] !== "application/json") {
        request.resume();
        return send(415, { reason: "json_required" });
      }
      let bytes = 0;
      const chunks = [];
      for await (const chunk of request.iterator({ destroyOnReturn: false })) {
        bytes += chunk.length;
        if (bytes > 65_536) {
          request.resume();
          return send(413, { reason: "body_too_large" });
        }
        chunks.push(chunk);
      }
      let input;
      try { input = JSON.parse(Buffer.concat(chunks).toString("utf8")); }
      catch { return send(400, { reason: "invalid_json" }); }
      const result = await drafts.execute(input, { operator });
      const status = { committed: 201, replayed: 200, conflict: 409, unauthorized: 403,
        validation_issue: 422, dependency_unavailable: 503 }[result.outcome];
      send(status ?? 503, result);
    } catch {
      send(503, { reason: "draft_service_unavailable" });
    }
  });
}

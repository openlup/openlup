import type { ConsentPushRequest } from "../contracts/marketingSync.js";

/** Private singleton translation. Local evidence is deliberately absent from wire attributes. */
export function consentCommand(request: ConsentPushRequest, target: { id: string; email: string }, listId: string | undefined) {
  if (request.payload.action === "withdraw" && request.audience.kind === "audience") {
    if (!listId) throw new Error("scope");
    return { method: "DELETE", path: `/api/lists/${listId}/relationships/profiles`, expected: [204],
      body: { data: [{ type: "profile", id: target.id }] } };
  }
  const grant = request.payload.action === "grant";
  const type = grant ? "profile-subscription-bulk-create-job" : "profile-subscription-bulk-delete-job";
  if (grant && !listId) throw new Error("scope");
  return { method: "POST", path: `/api/${type}s`, expected: [202], body: { data: { type,
    attributes: { profiles: { data: [{ type: "profile", ...(grant ? { id: target.id } : {}), attributes: {
      email: target.email, subscriptions: { email: { marketing: { consent: grant ? "SUBSCRIBED" : "UNSUBSCRIBED" } } },
    } }] } },
    ...(grant ? { relationships: { list: { data: { type: "list", id: listId } } } } : {}),
  } } };
}

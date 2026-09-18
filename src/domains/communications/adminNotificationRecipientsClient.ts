import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  adminNotificationRecipientsResponseSchema,
  createNotificationRecipientResponseSchema,
  deleteNotificationRecipientResponseSchema,
  updateNotificationRecipientResponseSchema,
  type AdminNotificationRecipientsRequest,
  type AdminNotificationRecipientsResponse,
  type CreateNotificationRecipientRequest,
  type CreateNotificationRecipientResponse,
  type DeleteNotificationRecipientRequest,
  type DeleteNotificationRecipientResponse,
  type UpdateNotificationRecipientRequest,
  type UpdateNotificationRecipientResponse,
} from "./contracts";

const PATH = "/api/bff/admin/communications/notification-recipients";

export function getAdminNotificationRecipients(
  accessToken: string,
  request: AdminNotificationRecipientsRequest,
  options: BffRequestOptions = {},
): Promise<AdminNotificationRecipientsResponse> {
  const headers = authHeaders(accessToken, options);

  return requestBff(`${PATH}?${queryString(request)}`, adminNotificationRecipientsResponseSchema, {
    ...options,
    method: "GET",
    headers,
  });
}

export function createAdminNotificationRecipient(
  accessToken: string,
  request: CreateNotificationRecipientRequest,
  options: BffRequestOptions = {},
): Promise<CreateNotificationRecipientResponse> {
  return mutate(accessToken, "POST", request, createNotificationRecipientResponseSchema, options);
}

export function updateAdminNotificationRecipient(
  accessToken: string,
  request: UpdateNotificationRecipientRequest,
  options: BffRequestOptions = {},
): Promise<UpdateNotificationRecipientResponse> {
  return mutate(accessToken, "PATCH", request, updateNotificationRecipientResponseSchema, options);
}

export function deleteAdminNotificationRecipient(
  accessToken: string,
  request: DeleteNotificationRecipientRequest,
  options: BffRequestOptions = {},
): Promise<DeleteNotificationRecipientResponse> {
  return mutate(accessToken, "DELETE", request, deleteNotificationRecipientResponseSchema, options);
}

function mutate<T>(
  accessToken: string,
  method: "POST" | "PATCH" | "DELETE",
  body: unknown,
  schema: Parameters<typeof requestBff<T>>[1],
  options: BffRequestOptions,
): Promise<T> {
  const headers = authHeaders(accessToken, options);

  return requestBff(PATH, schema, {
    ...options,
    method,
    headers,
    body,
  });
}

function authHeaders(accessToken: string, options: BffRequestOptions): Headers {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return headers;
}

function queryString(request: AdminNotificationRecipientsRequest): string {
  return new URLSearchParams({ notification_type: request.notification_type }).toString();
}

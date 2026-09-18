import { requestBff, type BffRequestOptions } from "@/lib/bff/client";
import {
  adminEmailSendEventsResponseSchema,
  adminEmailSendsResponseSchema,
  type AdminEmailSendEventsRequest,
  type AdminEmailSendEventsResponse,
  type AdminEmailSendsRequest,
  type AdminEmailSendsResponse,
} from "./contracts";

const PATH = "/api/bff/admin/communications/email-sends";
const EVENTS_PATH = "/api/bff/admin/communications/email-sends/events";

export function getAdminEmailSends(
  accessToken: string,
  request: AdminEmailSendsRequest,
  options: BffRequestOptions = {},
): Promise<AdminEmailSendsResponse> {
  return requestBff(
    `${PATH}?${queryString(request)}`,
    adminEmailSendsResponseSchema,
    {
      ...options,
      method: "GET",
      headers: authHeaders(accessToken, options),
    },
  );
}

export function getAdminEmailSendEvents(
  accessToken: string,
  request: AdminEmailSendEventsRequest,
  options: BffRequestOptions = {},
): Promise<AdminEmailSendEventsResponse> {
  return requestBff(
    `${EVENTS_PATH}?${eventsQueryString(request)}`,
    adminEmailSendEventsResponseSchema,
    {
      ...options,
      method: "GET",
      headers: authHeaders(accessToken, options),
    },
  );
}

function authHeaders(accessToken: string, options: BffRequestOptions): Headers {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return headers;
}

function queryString(request: AdminEmailSendsRequest): string {
  return new URLSearchParams({
    status: request.status,
    template: request.template,
    search: request.search,
    page: String(request.page),
    pageSize: String(request.pageSize),
  }).toString();
}

function eventsQueryString(request: AdminEmailSendEventsRequest): string {
  return new URLSearchParams({ sendId: request.sendId }).toString();
}

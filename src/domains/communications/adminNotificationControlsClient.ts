import { z } from "../../lib/validation/zod.js";
import { requestBff, type BffRequestOptions } from "@/lib/bff/client";

const NOTIFICATION_CONTROLS_PATH = "/api/bff/admin/communications/notification-controls";

export const notificationControlSchema = z.object({
  slug: z.string(),
  enabled: z.boolean(),
});

export const notificationControlsResponseSchema = z.object({
  controls: z.array(notificationControlSchema),
});

export const setNotificationControlResponseSchema = z.object({
  updated: z.boolean(),
  slug: z.string(),
  enabled: z.boolean(),
});

export type NotificationControl = z.infer<typeof notificationControlSchema>;
export type NotificationControlsResponse = z.infer<typeof notificationControlsResponseSchema>;

export function getAdminNotificationControls(
  accessToken: string,
  options: BffRequestOptions = {},
): Promise<NotificationControlsResponse> {
  return requestBff(NOTIFICATION_CONTROLS_PATH, notificationControlsResponseSchema, {
    ...options,
    method: "GET",
    headers: authHeaders(accessToken, options),
  });
}

export function setAdminNotificationControl(
  accessToken: string,
  request: { slug: string; enabled: boolean },
  options: BffRequestOptions = {},
): Promise<z.infer<typeof setNotificationControlResponseSchema>> {
  return requestBff(NOTIFICATION_CONTROLS_PATH, setNotificationControlResponseSchema, {
    ...options,
    method: "POST",
    body: request,
    headers: authHeaders(accessToken, options),
  });
}

function authHeaders(accessToken: string, options: BffRequestOptions): Headers {
  const headers = new Headers(options.headers);
  headers.set("Authorization", `Bearer ${accessToken}`);
  return headers;
}

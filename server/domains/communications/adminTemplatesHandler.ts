import type { VercelRequest, VercelResponse } from "../../_lib/types/vercel.js";
import {
  sendBffError,
  sendBffSuccess,
  sendMethodNotAllowed,
} from "../../_lib/bff/response.js";
import {
  adminEmailTemplatesResponseSchema,
  updateAdminEmailTemplateActiveRequestSchema,
  updateAdminEmailTemplateActiveResponseSchema,
  updateAdminEmailTemplateContentRequestSchema,
  updateAdminEmailTemplateContentResponseSchema,
} from "../../../src/domains/communications/contracts.js";
import { findUnsafeEmailTemplateHtmlFindings } from "../../../src/domains/communications/emailTemplateHtmlPolicy.js";
import { isDbEmailTemplateEditorAllowed } from "../../../src/domains/communications/dbEmailTemplatePolicy.js";
import type {
  CommunicationAdminTemplateActiveWritePort,
  CommunicationAdminTemplateContentWritePort,
  CommunicationAdminTemplatesReadPort,
} from "../../../src/domains/communications/ports.js";

export interface CommunicationsAdminTemplatesHandlerDeps {
  readPort: CommunicationAdminTemplatesReadPort;
  authorizeAdmin: (req: VercelRequest) => Promise<boolean>;
}

export interface CommunicationsAdminTemplateActiveHandlerDeps {
  readPort: CommunicationAdminTemplatesReadPort;
  writePort: CommunicationAdminTemplateActiveWritePort;
  authorizeAdmin: (req: VercelRequest) => Promise<boolean>;
}

export interface CommunicationsAdminTemplateContentHandlerDeps {
  readPort: CommunicationAdminTemplatesReadPort;
  writePort: CommunicationAdminTemplateContentWritePort;
  authorizeAdmin: (req: VercelRequest) => Promise<boolean>;
}

export function createCommunicationsAdminTemplatesReadHandler({
  readPort,
  authorizeAdmin,
}: CommunicationsAdminTemplatesHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "GET") {
      sendMethodNotAllowed(res, ["GET"]);
      return;
    }

    const authorized = await authorize(req, res, authorizeAdmin);
    if (!authorized) return;

    try {
      const result = await readPort.getAdminEmailTemplates();
      const response = adminEmailTemplatesResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Email templates returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Email templates read failed");
    }
  };
}

export function createCommunicationsAdminTemplateActiveHandler({
  readPort,
  writePort,
  authorizeAdmin,
}: CommunicationsAdminTemplateActiveHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "PATCH") {
      sendMethodNotAllowed(res, ["PATCH"]);
      return;
    }

    const authorized = await authorize(req, res, authorizeAdmin);
    if (!authorized) return;

    const request = updateAdminEmailTemplateActiveRequestSchema.safeParse(req.body);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid email template active update", {
        details: request.error.flatten(),
      });
      return;
    }

    if (!(await authorizeEditorMutation(request.data.templateId, readPort, res))) return;

    try {
      const result = await writePort.updateAdminEmailTemplateActive(request.data);
      const response = updateAdminEmailTemplateActiveResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Email template active update returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Email template active update failed");
    }
  };
}

export function createCommunicationsAdminTemplateContentHandler({
  readPort,
  writePort,
  authorizeAdmin,
}: CommunicationsAdminTemplateContentHandlerDeps) {
  return async function handler(req: VercelRequest, res: VercelResponse): Promise<void> {
    if (req.method !== "PATCH") {
      sendMethodNotAllowed(res, ["PATCH"]);
      return;
    }

    const authorized = await authorize(req, res, authorizeAdmin);
    if (!authorized) return;

    const request = updateAdminEmailTemplateContentRequestSchema.safeParse(req.body);
    if (!request.success) {
      sendBffError(res, "BAD_REQUEST", "Invalid email template content update", {
        details: request.error.flatten(),
      });
      return;
    }

    const unsafeHtmlFindings = findUnsafeEmailTemplateHtmlFindings(request.data.bodyHtml);
    if (unsafeHtmlFindings.length > 0) {
      sendBffError(res, "BAD_REQUEST", "Unsafe email template HTML", {
        details: { findings: unsafeHtmlFindings },
      });
      return;
    }

    if (!(await authorizeEditorMutation(request.data.templateId, readPort, res))) return;

    try {
      const result = await writePort.updateAdminEmailTemplateContent(request.data);
      const response = updateAdminEmailTemplateContentResponseSchema.safeParse(result);
      if (!response.success) {
        sendBffError(res, "INVALID_RESPONSE", "Email template content update returned invalid response");
        return;
      }

      sendBffSuccess(res, response.data);
    } catch {
      sendBffError(res, "UPSTREAM_UNAVAILABLE", "Email template content update failed");
    }
  };
}

async function authorizeEditorMutation(
  templateId: string,
  readPort: CommunicationAdminTemplatesReadPort,
  res: VercelResponse,
): Promise<boolean> {
  try {
    const result = await readPort.getAdminEmailTemplates();
    const response = adminEmailTemplatesResponseSchema.safeParse(result);
    if (!response.success) {
      sendBffError(res, "INVALID_RESPONSE", "Email templates returned invalid response");
      return false;
    }

    const template = response.data.templates.find((entry) => entry.id === templateId);
    if (!template || !isDbEmailTemplateEditorAllowed(template.slug)) {
      sendBffError(res, "BAD_REQUEST", "Email template is not editable");
      return false;
    }
    return true;
  } catch {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Email templates read failed");
    return false;
  }
}

async function authorize(
  req: VercelRequest,
  res: VercelResponse,
  authorizeAdmin: (req: VercelRequest) => Promise<boolean>,
): Promise<boolean> {
  try {
    if (await authorizeAdmin(req)) return true;
  } catch {
    sendBffError(res, "UPSTREAM_UNAVAILABLE", "Admin authorization failed");
    return false;
  }

  sendBffError(res, "UNAUTHORIZED", "Admin session required");
  return false;
}

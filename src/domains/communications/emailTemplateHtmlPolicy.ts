export const BLOCKED_EMAIL_TEMPLATE_TAGS = new Set([
  "base",
  "embed",
  "form",
  "iframe",
  "link",
  "math",
  "meta",
  "object",
  "script",
  "svg",
]);

export const EMAIL_TEMPLATE_URL_ATTRS = new Set([
  "action",
  "formaction",
  "href",
  "src",
  "xlink:href",
]);

export type EmailTemplateHtmlFinding =
  | "blocked_tag"
  | "event_handler"
  | "srcdoc"
  | "dangerous_url"
  | "dangerous_style";

export function findUnsafeEmailTemplateHtmlFindings(html: string): EmailTemplateHtmlFinding[] {
  const findings = new Set<EmailTemplateHtmlFinding>();
  for (const tag of html.matchAll(/<[^>]*>/g)) {
    const tagSource = tag[0];
    const tagName = tagSource.match(/^<\s*\/?\s*([a-zA-Z][a-zA-Z0-9:-]*)/)?.[1]?.toLowerCase();
    if (tagName && BLOCKED_EMAIL_TEMPLATE_TAGS.has(tagName)) {
      findings.add("blocked_tag");
    }

    for (const attr of tagSource.matchAll(/\s([a-zA-Z_:][a-zA-Z0-9_:.-]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g)) {
      const name = attr[1].toLowerCase();
      const value = attr[2] ?? attr[3] ?? attr[4] ?? "";
      if (name.startsWith("on")) findings.add("event_handler");
      if (name === "srcdoc") findings.add("srcdoc");
      if (isDangerousEmailTemplateUrlAttr(name, value)) findings.add("dangerous_url");
      if (name === "style" && isDangerousEmailTemplateStyle(value)) findings.add("dangerous_style");
    }
  }
  return [...findings];
}

export function isSafeEmailTemplateHtmlForStorage(html: string): boolean {
  return findUnsafeEmailTemplateHtmlFindings(html).length === 0;
}

export function isDangerousEmailTemplateUrlAttr(name: string, value: string): boolean {
  if (!EMAIL_TEMPLATE_URL_ATTRS.has(name)) return false;
  const normalized = normalizeUrlLikeValue(value);
  if (
    normalized.startsWith("javascript:") ||
    normalized.startsWith("vbscript:") ||
    normalized.startsWith("data:text/html") ||
    normalized.startsWith("data:image/svg+xml")
  ) {
    return true;
  }
  if (normalized.startsWith("data:")) {
    return !/^data:image\/(?:gif|jpe?g|png|webp);base64,/i.test(normalized);
  }
  return false;
}

export function isDangerousEmailTemplateStyle(value: string): boolean {
  const normalized = normalizeUrlLikeValue(value);
  return normalized.includes("expression(") || normalized.includes("url(");
}

function normalizeUrlLikeValue(value: string): string {
  return Array.from(value)
    .filter((char) => char.charCodeAt(0) > 0x1f && char.trim() !== "")
    .join("")
    .toLowerCase();
}

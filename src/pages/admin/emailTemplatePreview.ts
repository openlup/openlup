import {
  BLOCKED_EMAIL_TEMPLATE_TAGS,
  isDangerousEmailTemplateStyle,
  isDangerousEmailTemplateUrlAttr,
} from "@/domains/communications/emailTemplateHtmlPolicy";

const SAMPLE_VALUES: Record<string, string> = {
  first_name: "Jan",
  last_name: "Kowalski",
  dog_name: "Burek",
  cat_name: "Mruczek",
  tracking_number: "PL1234567890",
  tracking_url: "https://tracking.example.com",
  city: "Warszawa",
};

export function renderEmailTemplatePreviewHtml(templateHtml: string): string {
  let rendered = templateHtml;
  for (const [name, value] of Object.entries(SAMPLE_VALUES)) {
    rendered = rendered.replace(new RegExp(`\\{\\{${name}\\}\\}`, "g"), value);
  }
  return sanitizeEmailTemplatePreviewHtml(rendered);
}

export function buildEmailTemplatePreviewSrcDoc(templateHtml: string): string {
  const safeBody = renderEmailTemplatePreviewHtml(templateHtml);
  return `<!doctype html><html><head><meta charset="utf-8"><style>${previewCss()}</style></head><body>${safeBody}</body></html>`;
}

export function sanitizeEmailTemplatePreviewHtml(html: string): string {
  const template = document.createElement("template");
  template.innerHTML = html;
  sanitizeChildren(template.content);
  return template.innerHTML;
}

function sanitizeChildren(parent: ParentNode): void {
  for (const node of Array.from(parent.childNodes)) {
    if (node.nodeType !== Node.ELEMENT_NODE) continue;

    const element = node as Element;
    const tagName = element.tagName.toLowerCase();
    if (BLOCKED_EMAIL_TEMPLATE_TAGS.has(tagName)) {
      element.remove();
      continue;
    }

    for (const attr of element.getAttributeNames()) {
      const name = attr.toLowerCase();
      const value = element.getAttribute(attr) ?? "";
      if (
        name.startsWith("on") ||
        name === "srcdoc" ||
        isDangerousEmailTemplateUrlAttr(name, value) ||
        (name === "style" && isDangerousEmailTemplateStyle(value))
      ) {
        element.removeAttribute(attr);
      }
    }

    sanitizeChildren(element);
  }
}

function previewCss(): string {
  return [
    "html,body{margin:0;padding:0;background:#fff;color:#111;font-family:Arial,sans-serif;font-size:14px;line-height:1.5;}",
    "body{padding:24px;}",
    "img{max-width:100%;height:auto;}",
    "table{max-width:100%;}",
    "a{color:#167b80;}",
  ].join("");
}

import { SaxesParser, type SaxesAttributeNS, type SaxesTagNS } from "saxes";

const envelopeNamespace = "http://schemas.xmlsoap.org/soap/envelope/";
const encodingNamespace = "http://schemas.xmlsoap.org/soap/encoding/";
const declarationNamespace = "http://www.w3.org/2000/xmlns/";
const trimXmlSpace = (text: string) => text.replace(/^[ \t\r\n]+|[ \t\r\n]+$/gu, "");
const faultFields = ["faultcode", "faultstring", "faultactor", "detail"];

type ResultContract = { namespace: string; response: string; result: string };
type Outcome = { kind: "accepted"; ids: string[] } | { kind: "client_refusal"; reason: string };

function supportedEncoding(attribute: SaxesAttributeNS): boolean {
  return attribute.uri === envelopeNamespace && attribute.local === "encodingStyle"
    && ["", encodingNamespace].includes(trimXmlSpace(attribute.value));
}

function validLiteralAttributes(tag: SaxesTagNS, allowLanguage = false): boolean {
  return Object.values(tag.attributes).every(attribute => attribute.uri === declarationNamespace || supportedEncoding(attribute)
    || (allowLanguage && attribute.uri === "http://www.w3.org/XML/1998/namespace" && attribute.local === "lang"));
}

/** Read one SOAP 1.1 Body member and the operation's string-array result. */
export function readSoap11Reply(xml: string, contract: ResultContract): Outcome | null {
  const parser = new SaxesParser({ xmlns: true });
  const ids: string[] = [];
  let valid = true;
  let depth = 0;
  let section: "header" | "body" | null = null;
  let headerSeen = false;
  let bodyCount = 0;
  let bodyMembers = 0;
  let member: "fault" | "result" | null = null;
  let lastFaultField = -1;
  let fieldText = "";
  let clientCode = false;
  let reason = "";
  let resultCount = 0;

  const invalidate = () => { valid = false; };
  parser.on("error", invalidate);
  parser.on("doctype", invalidate);
  parser.on("processinginstruction", invalidate);

  parser.on("opentag", tag => {
    depth++;
    if (depth === 1) {
      valid &&= tag.local === "Envelope" && tag.uri === envelopeNamespace
        && validLiteralAttributes(tag);
      return;
    }
    if (depth === 2) {
      valid &&= tag.uri === envelopeNamespace && validLiteralAttributes(tag);
      if (tag.local === "Body") {
        section = "body";
        bodyCount++;
      } else if (tag.local === "Header" && !headerSeen && bodyCount === 0) {
        section = "header";
        headerSeen = true;
      } else invalidate();
      return;
    }
    if (section === "header" && depth === 3) {
      const mandatory = Object.values(tag.attributes).some(attribute => attribute.uri === envelopeNamespace
        && attribute.local === "mustUnderstand" && attribute.value !== "0");
      if (tag.uri === "" || mandatory) invalidate();
    }
    if (section !== "body") return;
    if (depth === 3) {
      bodyMembers++;
      valid &&= validLiteralAttributes(tag);
      if (tag.local === "Fault" && tag.uri === envelopeNamespace) member = "fault";
      else if (tag.local === contract.response && tag.uri === contract.namespace) member = "result";
      else invalidate();
      return;
    }

    if (member === "fault") {
      if (depth === 4) {
        const field = faultFields.indexOf(tag.local);
        valid &&= tag.uri === "" && field > lastFaultField && validLiteralAttributes(tag, field === 1);
        lastFaultField = field;
        fieldText = "";
      } else if (depth === 5 && lastFaultField < 3) invalidate();
      return;
    }

    if (depth === 4) {
      resultCount++;
      valid &&= tag.local === contract.result && tag.uri === "" && validLiteralAttributes(tag);
    } else if (depth === 5) {
      valid &&= tag.local === "item" && tag.uri === "" && validLiteralAttributes(tag);
      fieldText = "";
    } else invalidate();
  });

  function collectText(text: string) {
    if (depth <= 2 || (section === "body" && (depth === 3 || (member === "result" && depth === 4)))) {
      if (/[^ \t\r\n]/u.test(text)) invalidate();
      return;
    }
    if (section === "body" && ((member === "fault" && depth === 4) || (member === "result" && depth === 5))) {
      fieldText += text;
    }
  }
  parser.on("text", collectText);
  parser.on("cdata", collectText);
  parser.on("closetag", () => {
    if (section === "body" && member === "fault" && depth === 4) {
      if (lastFaultField === 0) {
        const code = /^(?:([\w.-]+):)?Client$/u.exec(trimXmlSpace(fieldText));
        clientCode = Boolean(code && parser.resolve(code[1] ?? "") === envelopeNamespace);
      } else if (lastFaultField === 1) reason = fieldText.trim();
    }
    if (section === "body" && member === "result" && depth === 5) {
      const id = fieldText.trim();
      if (id) ids.push(id);
      else invalidate();
    }
    if (depth === 2) section = null;
    depth--;
  });
  parser.write(xml).close();

  if (!valid || bodyCount !== 1 || bodyMembers !== 1) return null;
  if (member === "fault" && clientCode && reason) return { kind: "client_refusal", reason };
  if (member === "result" && resultCount === 1 && ids.length) return { kind: "accepted", ids: [...new Set(ids)] };
  return null;
}

import { SaxesParser } from "saxes";

const envelopeNamespace = "http://schemas.xmlsoap.org/soap/envelope/";
const faultFields = ["faultcode", "faultstring", "faultactor", "detail"];

type ResultContract = { namespace: string; response: string; result: string };
type Outcome = { kind: "accepted"; ids: string[] } | { kind: "client_refusal"; reason: string };

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
        && Object.values(tag.attributes).every(attribute => attribute.uri !== "");
      return;
    }
    if (depth === 2) {
      valid &&= tag.uri === envelopeNamespace && Object.values(tag.attributes).every(attribute => attribute.uri !== "");
      if (tag.local === "Body") {
        section = "body";
        bodyCount++;
      } else if (tag.local === "Header" && !headerSeen && bodyCount === 0) {
        section = "header";
        headerSeen = true;
      } else invalidate();
      return;
    }
    if (section === "header" && depth === 3 && tag.uri === "") invalidate();
    if (section !== "body") return;
    if (depth === 3) {
      bodyMembers++;
      if (tag.local === "Fault" && tag.uri === envelopeNamespace) member = "fault";
      else if (tag.local === contract.response && tag.uri === contract.namespace) member = "result";
      else invalidate();
      return;
    }

    if (member === "fault") {
      if (depth === 4) {
        const field = faultFields.indexOf(tag.local);
        valid &&= tag.uri === "" && field > lastFaultField;
        lastFaultField = field;
        fieldText = "";
      } else if (depth === 5 && lastFaultField < 3) invalidate();
      return;
    }

    const nil = Object.values(tag.attributes).some(
      attribute => attribute.uri === "http://www.w3.org/2001/XMLSchema-instance" && attribute.local === "nil",
    );
    if (depth === 4) {
      resultCount++;
      valid &&= tag.local === contract.result && tag.uri === "" && !nil;
    } else if (depth === 5) {
      valid &&= tag.local === "item" && tag.uri === "" && !nil;
      fieldText = "";
    } else invalidate();
  });

  function collectText(text: string) {
    if (depth <= 2 || (section === "body" && (depth === 3 || (member === "result" && depth === 4)))) {
      if (text.trim()) invalidate();
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
        const code = /^(?:([\w.-]+):)?Client$/u.exec(fieldText.trim());
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

import { SaxesParser } from "saxes";

const soap11Namespace = "http://schemas.xmlsoap.org/soap/envelope/";

/** A retry requires a complete SOAP 1.1 client fault before another call. */
export function readSoap11ClientRefusal(xml: string): string | null {
  const parser = new SaxesParser({ xmlns: true });
  const path: string[] = [];
  let depth = 0;
  let valid = true;
  let headerSeen = false;
  let bodyCount = 0;
  let faultCount = 0;
  let faultCode = "";
  let faultReason = "";
  let codeCount = 0;
  let reasonCount = 0;
  let lastFaultField = -1;
  const faultFields = ["faultcode", "faultstring", "faultactor", "detail"];
  const faultPath = "Envelope/Body/Fault";
  const codePath = `${faultPath}/faultcode`;
  const reasonPath = `${faultPath}/faultstring`;
  parser.on("error", () => { valid = false; });
  parser.on("doctype", () => { valid = false; });
  parser.on("processinginstruction", () => { valid = false; });
  parser.on("opentag", tag => {
    depth++;
    if (depth > 4) {
      if (depth === 5 && [codePath, reasonPath].includes(path.join("/"))) valid = false;
      return;
    }
    path.push(tag.local);
    const current = path.join("/");
    if (path.length === 1) valid &&= current === "Envelope" && tag.uri === soap11Namespace;
    if (depth === 2) {
      if (tag.uri !== soap11Namespace) valid = false;
      if (tag.local === "Body") bodyCount++;
      else if (tag.local === "Header" && !headerSeen && bodyCount === 0) headerSeen = true;
      else valid = false;
    }
    if (path.length === 3 && path[1] === "Body") {
      valid &&= current === faultPath && tag.uri === soap11Namespace;
      faultCount++;
    }
    if (depth === 4 && path[1] === "Body" && path[2] === "Fault") {
      const field = faultFields.indexOf(tag.local);
      valid &&= tag.uri === "" && field > lastFaultField;
      lastFaultField = field;
      if (current === codePath) codeCount++;
      if (current === reasonPath) reasonCount++;
    }
  });
  function collectText(text: string) {
    if ((depth === 1 || (depth <= 3 && path[1] === "Body")) && text.trim()) valid = false;
    if (depth !== 4) return;
    const current = path.join("/");
    if (current === codePath) faultCode += text;
    if (current === reasonPath) faultReason += text;
  }
  parser.on("text", collectText);
  parser.on("cdata", collectText);
  parser.on("closetag", () => {
    if (depth-- > 4) return;
    if (path.join("/") === codePath) {
      const code = faultCode.trim();
      const prefix = /^(?:([\w.-]+):)?Client$/u.exec(code);
      valid &&= Boolean(prefix && parser.resolve(prefix[1] ?? "") === soap11Namespace);
    }
    path.pop();
  });
  parser.write(xml).close();
  return valid && bodyCount === 1 && faultCount === 1 && codeCount === 1 && reasonCount === 1
    ? faultReason.trim() || null
    : null;
}

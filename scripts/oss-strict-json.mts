export class DuplicateJsonKeyError extends Error {}

type JsonFrame =
  | { keys: Set<string>; key: string; expectsKey: boolean }
  | { index: number };

// The trusted reviewed-platform-forward registry reader, the publication catalogue parser and the neutrality ratchet parse their JSON inputs through one strict reader that refuses any object with two keys equal after JSON string decoding, with an actionable error naming the file, the key and the JSON path. Valid inputs without duplicates parse to exactly the same values as JSON.parse. No other JSON readers, file formats or rules change.
export function parseStrictJson(source: string, file: string): unknown {
  const value: unknown = JSON.parse(source);
  const stack: JsonFrame[] = [];

  // Native parsing validates the grammar first. Only strings and structural
  // punctuation are needed to locate keys and their paths in valid JSON.
  for (let index = 0; index < source.length; index += 1) {
    const token = source[index];
    const frame = stack.at(-1);
    if (token === "{") {
      stack.push({ keys: new Set(), key: "", expectsKey: true });
    } else if (token === "[") {
      stack.push({ index: 0 });
    } else if (token === "}" || token === "]") {
      stack.pop();
    } else if (token === "," && frame) {
      if ("keys" in frame) frame.expectsKey = true;
      else frame.index += 1;
    } else if (token === '"') {
      const start = index;
      index += 1;
      // Skip an escaped character so an escaped quote stays inside the string.
      while (source[index] !== '"') index += source[index] === "\\" ? 2 : 1;
      if (!frame || !("keys" in frame) || !frame.expectsKey) continue;

      const key = JSON.parse(source.slice(start, index + 1)) as string;
      frame.key = key;
      frame.expectsKey = false;
      if (frame.keys.has(key)) {
        const path = stack.map((parent) => `[${JSON.stringify("keys" in parent ? parent.key : parent.index)}]`).join("");
        throw new DuplicateJsonKeyError(`${file}: duplicate JSON key ${JSON.stringify(key)} at $${path}. Remove the duplicate member.`);
      }
      frame.keys.add(key);
    }
  }
  return value;
}

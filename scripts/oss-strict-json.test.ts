import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { parseStrictJson } from "./oss-strict-json.mts";

it.each([
  "null", "true", "false", "-0", "9007199254740993", "1e400", "-1e-400",
  String.raw`"\uD800\uD83D\uDE00\r\n\t\b\f\"\\\/"`,
  String.raw` {"a\"b": [[], [{"q":null}], {"q":false}], "__proto__": {"x":1}, "a\\b": "{},[]"} `,
  '{"é": 1, "é": 2, "😀": 3, "": 4}',
  '\t\r\n["\u2028\u2029", -0, 1e400, -1e-400, 9007199254740993]\n',
])("matches JSON.parse for %s", (source) => {
  expect(parseStrictJson(source, "fixture.json")).toStrictEqual(JSON.parse(source));
});

it("matches JSON.parse for a multi-MiB key and string value with escapes", () => {
  const text = 'ordinary 雪 " \\ \n [,{]} '.repeat(512 * 1024);
  const source = JSON.stringify({ [text]: text });
  expect(parseStrictJson(source, "fixture.json")).toStrictEqual(JSON.parse(source));
});

it("reports native syntax errors before checking for duplicates", () => {
  expect(() => parseStrictJson('{"a": 1, "a": 2,}', "fixture.json")).toThrow(SyntaxError);
});

it.each([
  "config/reviewed-platform-forwards.json",
  "config/openlup-publication-catalog.json",
  "config/openlup-neutrality-baseline.json",
  "packages/platform/package.json",
  "packages/platform/release-gates.json",
])("preserves the parsed value of %s", (file) => {
  const source = readFileSync(file, "utf8");
  expect(parseStrictJson(source, file)).toStrictEqual(JSON.parse(source));
});

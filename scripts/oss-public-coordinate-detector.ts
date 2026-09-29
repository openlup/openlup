const exact = [["https://github.com/example", "app"].join("/"), ["An adopter conformance", "test"].join(" ")];
export function carriesPrivateOperationalCoordinate(contents: string, _path = ""): boolean { return exact.some((value) => contents.includes(value)); }

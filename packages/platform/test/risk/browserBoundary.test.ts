import { build } from "esbuild";
import { fileURLToPath } from "node:url";
import { expect, it } from "vitest";
// One boundary case; exercise both source and emitted bytes in that case.
it("keeps schemas browser-safe, contracts empty and server Node-only", async () => {
    for (const tree of ["src", "dist"]) {
        const entry = (name: string) => fileURLToPath(new URL(`../../${tree}/risk/${name}index.${tree === "src" ? "ts" : "js"}`, import.meta.url));
        for (const name of ["", "contracts/"]) {
            const result = await build({ entryPoints: [entry(name)], bundle: true, platform: "browser", format: "esm", write: false, metafile: true, treeShaking: false });
            expect(Object.keys(result.metafile.inputs).filter(p => p.includes("/server/") || p.startsWith("node:"))).toEqual([]);
            if (name)
                expect(result.outputFiles[0].text.trim()).toBe("");
        }
        await expect(build({ entryPoints: [entry("server/")], bundle: true, platform: "browser", write: false, logLevel: "silent" })).rejects.toThrow(/node:crypto/);
    }
});

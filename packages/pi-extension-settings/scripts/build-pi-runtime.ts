import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import * as esbuild from "esbuild";

const packageRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
const external = [
    "@earendil-works/pi-agent-core",
    "@earendil-works/pi-agent-core/*",
    "@earendil-works/pi-ai",
    "@earendil-works/pi-ai/*",
    "@earendil-works/pi-coding-agent",
    "@earendil-works/pi-coding-agent/*",
    "@earendil-works/pi-tui",
    "@earendil-works/pi-tui/*",
    "@mariozechner/*",
    "@sinclair/typebox",
    "@sinclair/typebox/*",
    "typebox",
    "typebox/*",
];

for (const entry of ["pi", "runtime"]) {
    const outfile = path.join(packageRoot, "dist", `${entry}.ts`);
    const result = await esbuild.build({
        absWorkingDir: packageRoot,
        entryPoints: [`src/${entry}.ts`],
        outfile,
        bundle: true,
        platform: "node",
        format: "esm",
        target: "node24",
        treeShaking: true,
        sourcemap: true,
        sourcesContent: true,
        legalComments: "none",
        external,
        metafile: true,
    });
    const bundledHostInputs = Object.keys(result.metafile.inputs).filter((input) =>
        /node_modules\/(?:@earendil-works|@mariozechner|@sinclair\/typebox|typebox)\//u.test(input),
    );
    if (bundledHostInputs.length > 0) {
        throw new Error(`Host identity modules entered ${entry}: ${bundledHostInputs.join(", ")}`);
    }
    const output = await readFile(outfile, "utf8");
    if (output.includes(packageRoot)) {
        throw new Error(`${entry} bundle contains an absolute workspace path`);
    }
}

import { describe, expect, it } from "vitest";
import { omitLeadingImportPrologue } from "../src/script-preview/prologue.ts";

describe("script import prologue selection", () => {
    it("keeps imports when the complete script fits", () => {
        expect(
            omitLeadingImportPrologue("import os\nprint(os.getcwd())", "python", 2),
        ).toBeUndefined();
    });

    it("omits complete multiline Python imports", () => {
        const code = [
            "from package import (",
            "    first,",
            "    second,",
            ")",
            "import os \\",
            "    as operating_system",
            "",
            "print(first)",
            "print(second)",
        ].join("\n");

        expect(omitLeadingImportPrologue(code, "python", 4)).toEqual({
            code: "print(first)\nprint(second)",
            omittedLines: 7,
        });
    });

    it("omits complete JavaScript and require declarations", () => {
        const code = [
            "import {",
            "  join,",
            "  resolve,",
            "} from 'node:path';",
            "const {",
            "  readFileSync,",
            "} = require('node:fs');",
            "",
            "console.log(join(resolve('.'), readFileSync.name));",
        ].join("\n");

        expect(omitLeadingImportPrologue(code, "javascript", 4)).toEqual({
            code: "console.log(join(resolve('.'), readFileSync.name));",
            omittedLines: 8,
        });
    });

    it("does not skip comments, docstrings, or scripts containing only imports", () => {
        expect(
            omitLeadingImportPrologue(
                "# setup\nimport os\nprint(os.getcwd())\nprint('done')",
                "python",
                2,
            ),
        ).toBeUndefined();
        expect(
            omitLeadingImportPrologue('"""module"""\nimport os\nprint(os.getcwd())', "python", 2),
        ).toBeUndefined();
        expect(omitLeadingImportPrologue("import os\nimport sys", "python", 1)).toBeUndefined();
    });
});

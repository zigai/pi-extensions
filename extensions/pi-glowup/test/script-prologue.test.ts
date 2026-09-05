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

    it.each([
        ["python", 'import os; print("BODY")'],
        ["python", 'from os import (\n    path\n); print("BODY")'],
        ["javascript", 'import fs from "node:fs"; console.log("BODY");'],
        ["javascript", 'const fs = require("node:fs"); console.log("BODY");'],
        ["typescript", 'import type { Stats } from "node:fs"; console.log("BODY");'],
        ["typescript", 'const fs = require(\n    "node:fs"\n); /* comment */ console.log("BODY");'],
        ["javascript", 'import "node:fs"; "BODY";'],
    ])("retains mixed import/body ranges in %s", (language, mixedLine) => {
        const body = `${mixedLine}\nprintOrLog(1)\nprintOrLog(2)`;
        expect(omitLeadingImportPrologue(body, language, 1)).toBeUndefined();

        const leadingImport = language === "python" ? "import sys" : 'import "node:path";';
        expect(omitLeadingImportPrologue(`${leadingImport}\n${body}`, language, 1)).toEqual({
            code: body,
            omittedLines: 1,
        });
    });

    it.each([
        ["python", "import os; # terminal semicolon"],
        ["javascript", 'import "package;name"; // terminal semicolon'],
        ["typescript", 'const fs = require("package;name"); /* terminal semicolon */'],
        ["javascript", 'import "package;name"; /* multiline\ncomment */'],
    ])("still omits quoted or terminal semicolons in %s", (language, setup) => {
        expect(omitLeadingImportPrologue(`${setup}\nBODY\nTAIL`, language, 1)).toEqual({
            code: "BODY\nTAIL",
            omittedLines: setup.split("\n").length,
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

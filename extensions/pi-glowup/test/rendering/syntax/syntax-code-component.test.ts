import { describe, expect, it } from "vitest";
import { detectStructuredOutputLanguage } from "../../../src/rendering/syntax/code-component.ts";
import { syntaxLanguageFromFile } from "../../../src/rendering/syntax/language.ts";

describe("syntax code component helpers", () => {
    it("detects small structured output languages", () => {
        expect(detectStructuredOutputLanguage('{"ok":true}')).toBe("json");
        expect(detectStructuredOutputLanguage("<root><item /></root>")).toBe("xml");
        expect(detectStructuredOutputLanguage("git status --short")).toBe("bash");
    });

    it("skips structured detection for huge outputs", () => {
        const hugeJson = `{${'"value":'.padStart(65 * 1024, " ")}true}`;

        expect(detectStructuredOutputLanguage(hugeJson)).toBeUndefined();
    });

    it.each([
        "#!/usr/bin/python3",
        "#!/usr/bin/env python3",
        "#!/usr/bin/env -S python3 -u",
        "#!/usr/bin/env -S uv run --script",
    ])("detects Python from an extensionless script shebang: %s", (shebang) => {
        expect(syntaxLanguageFromFile("bin/serve-model", `${shebang}\nprint('ready')\n`)).toBe(
            "python",
        );
    });

    it.each([
        ["#!/bin/sh", "bash"],
        ["#!/usr/bin/env -S bash -eu", "bash"],
        ["#!/usr/bin/env zsh", "zsh"],
        ["#!/usr/bin/fish", "fish"],
        ["#!/usr/bin/env node", "javascript"],
        ["#!/usr/bin/env ts-node", "typescript"],
        ["#!/usr/bin/env ruby", "ruby"],
        ["#!/usr/bin/env perl", "perl"],
        ["#!/usr/bin/env php", "php"],
        ["#!/usr/bin/env lua", "lua"],
        ["#!/usr/bin/env pwsh", "powershell"],
    ])("detects common extensionless script shebang %s as %s", (shebang, language) => {
        expect(syntaxLanguageFromFile("bin/script", `${shebang}\nrun\n`)).toBe(language);
    });

    it("skips env options, variable assignments, and unset arguments", () => {
        expect(
            syntaxLanguageFromFile(
                "bin/script",
                "#!/usr/bin/env -i -u OLD_MODE MODE=ci bash -eu\necho ready\n",
            ),
        ).toBe("bash");
    });

    it("prefers a recognized file extension over the shebang", () => {
        expect(
            syntaxLanguageFromFile("bin/example.sh", "#!/usr/bin/python3\nprint('ready')\n"),
        ).toBe("bash");
    });
});

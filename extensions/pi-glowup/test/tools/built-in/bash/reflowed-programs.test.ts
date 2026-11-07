import { expect, it } from "vitest";
import { analyzeBashCommand } from "../../../../src/tools/built-in/bash/command.ts";
import {
    extractEmbeddedPrograms,
    sourceCharacterAt,
} from "../../../../src/tools/built-in/bash/embedded-programs.ts";
import { reflowedEmbeddedPrograms } from "../../../../src/tools/built-in/bash/reflowed-programs.ts";

it.each([
    `echo 'print(42)'; python3 -c 'print(42)' && echo done`,
    `pwd && node - <<-'JS'\r\n\tconsole.log("café 🧪");\r\nJS\r\n`,
    `pwd && bash -lc 'python3 -c "print(42)"' || echo done`,
    String.raw`pwd && node -e "console.log(\"café 🧪\")" && echo done`,
])("preserves decoded program ranges and ancestry in both reflow layouts: %s", (source) => {
    const programs = extractEmbeddedPrograms(source);
    expect(programs.length).toBeGreaterThan(0);
    const original = JSON.stringify(programs);

    for (const position of ["leading", "trailing"] as const) {
        const analysis = analyzeBashCommand(source, position, programs);
        const display = analysis.reflowedCommand;
        const mapped = analysis.reflowedPrograms;
        if (display === undefined || mapped === undefined)
            throw new Error("Expected mapped reflow");

        expect(mapped).toHaveLength(programs.length);

        for (const [index, before] of programs.entries()) {
            const after = mapped[index];
            if (after === undefined) throw new Error("Missing projected program");

            expect(after.code).toBe(before.code);
            expect(display.slice(after.start, after.end)).toBe(
                source.slice(before.start, before.end),
            );

            if (before.parent !== undefined)
                expect(after.parent).toBe(mapped[programs.indexOf(before.parent)]);

            for (let at = 0; at < before.code.length; at++) {
                const left = sourceCharacterAt(before.characters ?? [], at);
                const right = sourceCharacterAt(after.characters ?? [], at);
                expect(right === undefined).toBe(left === undefined);

                if (left !== undefined && right !== undefined)
                    expect(display.slice(right.start, right.end)).toBe(
                        source.slice(left.start, left.end),
                    );
            }
        }
    }

    expect(JSON.stringify(programs)).toBe(original);
});

it("does not confuse earlier ordinary strings with identical interpreter operands", () => {
    const source = `echo 'print(42)'; python3 -c 'print(42)' && echo done`;
    const analysis = analyzeBashCommand(source, "leading");
    const display = analysis.reflowedCommand;
    if (display === undefined) throw new Error("Expected reflow");

    expect(analysis.reflowedPrograms?.[0]?.start).toBe(display.lastIndexOf("'print(42)'"));
});

it("rejects non-whitespace source changes and reuses unchanged metadata", () => {
    const source = `pwd && node -e 'const value = 1;'`;
    const programs = extractEmbeddedPrograms(source);
    expect(reflowedEmbeddedPrograms(source, source, programs)).toBe(programs);
    expect(
        reflowedEmbeddedPrograms(source, source.replace("value", "other"), programs),
    ).toBeUndefined();
});

it.each(["", "   \n", "\n", "\t\r\n"])(
    "preserves empty/whitespace heredoc spans across reflow: %j",
    (body) => {
        const source = `pwd && python - <<'PY'\n${body}PY\n`;
        const programs = extractEmbeddedPrograms(source);
        expect(programs).toHaveLength(1);
        const analysis = analyzeBashCommand(source, "leading", programs);
        const display = analysis.reflowedCommand;
        const mapped = analysis.reflowedPrograms;
        expect(mapped).toHaveLength(1);

        if (display === undefined || mapped?.[0] === undefined || programs[0] === undefined)
            throw new Error("Expected blank heredoc projection");

        expect(mapped[0].code).toBe(body);
        expect(display.slice(mapped[0].start, mapped[0].end)).toBe(
            source.slice(programs[0].start, programs[0].end),
        );
    },
);

it("rejects a blank heredoc whose payload whitespace changed during display transformation", () => {
    const source = `pwd && python - <<'PY'\n \nPY\n`;
    const display = source.replace(" && ", "\n&& ").replace("\n \n", "\n  \n");
    expect(reflowedEmbeddedPrograms(source, display, extractEmbeddedPrograms(source))).toEqual([]);
});

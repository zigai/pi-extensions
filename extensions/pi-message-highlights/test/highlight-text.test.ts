import assert from "node:assert/strict";
import { test } from "vitest";

import {
    highlightMessageLine,
    highlightMessageLines,
    type HighlightStyles,
} from "../src/highlight-text.ts";

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const styles: HighlightStyles = {
    url: "<url>",
    filepath: "<path>",
};

function readEscapeSequence(text: string, start: number): string {
    const introducer = text.at(start + 1);
    if (introducer === undefined) return text.slice(start, start + 1);

    if (introducer === "[") {
        for (let index = start + 2; index < text.length; index += 1) {
            const code = text.charCodeAt(index);
            if (code >= 0x40 && code <= 0x7e) return text.slice(start, index + 1);
        }

        return text.slice(start);
    }

    if (introducer === "]") {
        const belIndex = text.indexOf(BEL, start + 2);
        if (belIndex === -1) return text.slice(start);
        return text.slice(start, belIndex + BEL.length);
    }

    return text.slice(start, start + 2);
}

function stripAnsi(text: string): string {
    const output: string[] = [];
    let index = 0;
    while (index < text.length) {
        if (text[index] === ESC) {
            index += readEscapeSequence(text, index).length;
            continue;
        }

        output.push(text[index] ?? "");
        index += 1;
    }

    return output.join("").replace(/<url>|<path>/g, "");
}

test.each([
    ["", ""],
    [`${ESC}[1m`, `${ESC}[1m`],
    [`${ESC}[2m`, undefined],
    [`${ESC}[1;2m`, undefined],
])("restores surrounding intensity after faint URL highlighting (%j)", (opening, restored) => {
    const faintStyles: HighlightStyles = {
        url: `${ESC}[39m${ESC}[2m`,
        filepath: "",
    };
    let closing = "";
    if (restored !== undefined) closing = `${ESC}[22m${restored}`;

    assert.equal(
        highlightMessageLine(`${opening}See https://example.com then NORMAL`, faintStyles),
        `${opening}See ${faintStyles.url}https://example.com${ESC}[39m${closing} then NORMAL`,
    );
});

test("does not interpret RGB components as intensity controls", () => {
    const rgbStyles: HighlightStyles = { url: `${ESC}[38;2;1;2;22m`, filepath: "" };
    assert.equal(
        highlightMessageLine("See https://example.com then NORMAL", rgbStyles),
        `See ${rgbStyles.url}https://example.com${ESC}[39m then NORMAL`,
    );
});

test("highlights URLs and file paths without changing visible text", () => {
    const line = "Open https://example.com/docs and packages/pi-footer/src/index.ts.";
    const highlighted = highlightMessageLine(line, styles);
    assert.equal(stripAnsi(highlighted), line);
    assert.equal(highlighted.includes(`<url>https://example.com/docs${ESC}[39m`), true);
    assert.equal(highlighted.includes(`<path>packages/pi-footer/src/index.ts${ESC}[39m.`), true);
});

test("highlights common bare filenames", () => {
    const line = "Edit README.md, query.sql, and package.json:12 next.";
    const highlighted = highlightMessageLine(line, styles);
    assert.equal(stripAnsi(highlighted), line);
    assert.equal(highlighted.includes(`<path>README.md${ESC}[39m`), true);
    assert.equal(highlighted.includes(`<path>query.sql${ESC}[39m`), true);
    assert.equal(highlighted.includes(`<path>package.json:12${ESC}[39m`), true);
});

test("does not highlight code value property access as a bare filename", () => {
    const lines = ["        body: args.sql,", "const body = args.sql;"];

    for (const line of lines) {
        const highlighted = highlightMessageLine(line, styles);
        assert.equal(highlighted, line);
    }
});

test("does not highlight slash-separated prose as a file path", () => {
    const lines = [
        "Not before — I had only covered the configured/current extensions",
        "alpha/beta/gamma",
        "Do we have guidance on how boolean variables and functions /methods should be named?",
        "Use /help to list slash commands.",
    ];

    for (const line of lines) {
        const highlighted = highlightMessageLine(line, styles);
        assert.equal(highlighted, line);
    }
});

test("highlights absolute paths when they are specific enough", () => {
    const line = "Open /home/zigai/Projects/pi-tweaks and /tmp/file.ts next.";
    const highlighted = highlightMessageLine(line, styles);
    assert.equal(stripAnsi(highlighted), line);
    assert.equal(highlighted.includes(`<path>/home/zigai/Projects/pi-tweaks${ESC}[39m`), true);
    assert.equal(highlighted.includes(`<path>/tmp/file.ts${ESC}[39m`), true);
});

test("highlights absolute file paths with spaced directory segments", () => {
    const line = "Use /mnt/d/Software/Linux Distros/Fedora-Server-dvd-x86_64-44-1.7.iso for setup.";
    const highlighted = highlightMessageLine(line, styles);
    assert.equal(stripAnsi(highlighted), line);
    assert.equal(
        highlighted.includes(
            `<path>/mnt/d/Software/Linux Distros/Fedora-Server-dvd-x86_64-44-1.7.iso${ESC}[39m for setup.`,
        ),
        true,
    );
});

test("highlights file paths split across rendered message lines", () => {
    const lines = [
        "   from this /mnt/d/Software/Linux            ",
        "   Distros/Fedora-Server-dvd-x86_64-",
        "   44-1.7.iso it should             ",
    ];

    const highlighted = highlightMessageLines(lines, styles);
    assert.deepEqual(highlighted.map(stripAnsi), lines);
    assert.equal(highlighted[0]?.includes(`from this <path>/mnt/d/Software/Linux${ESC}[39m`), true);
    assert.equal(
        highlighted[1]?.includes(`   <path>Distros/Fedora-Server-dvd-x86_64-${ESC}[39m`),
        true,
    );
    assert.equal(highlighted[2]?.includes(`   <path>44-1.7.iso${ESC}[39m it should`), true);
});

test("does not join prose before an absolute wrapped path", () => {
    const lines = [
        "   one, but no gui, from this          ",
        "   /mnt/d/Software/Linux              ",
        "   Distros/Fedora-Server-dvd-x86_64-4 ",
        "   4-1.7.iso it should                ",
    ];

    const highlighted = highlightMessageLines(lines, styles);
    assert.deepEqual(highlighted.map(stripAnsi), lines);
    assert.equal(highlighted[0]?.includes("<path>this"), false);
    assert.equal(highlighted[1]?.includes(`   <path>/mnt/d/Software/Linux${ESC}[39m`), true);
    assert.equal(
        highlighted[2]?.includes(`   <path>Distros/Fedora-Server-dvd-x86_64-4${ESC}[39m`),
        true,
    );
    assert.equal(highlighted[3]?.includes(`   <path>4-1.7.iso${ESC}[39m it should`), true);
});

test("does not highlight path-like text inside a URL twice", () => {
    const highlighted = highlightMessageLine("See https://example.com/src/index.ts", styles);
    assert.equal((highlighted.match(/<url>/g) ?? []).length, 1);
    assert.equal((highlighted.match(/<path>/g) ?? []).length, 0);
});

test("restores the previous foreground after a highlighted path", () => {
    const dim = `${ESC}[38;5;8m`;
    const line = `${dim}Read src/config.ts next${ESC}[39m`;
    const highlighted = highlightMessageLine(line, styles);
    assert.equal(stripAnsi(highlighted), "Read src/config.ts next");
    assert.equal(highlighted.includes(`<path>src/config.ts${ESC}[38;5;8m next`), true);
});

test("ignores URLs inside OSC control sequences", () => {
    const line = `${ESC}]8;;https://example.com${BEL}link${ESC}]8;;${BEL} and ./local/file.ts`;
    const highlighted = highlightMessageLine(line, styles);
    assert.equal(stripAnsi(highlighted), "link and ./local/file.ts");
    assert.equal(highlighted.includes("<url>"), false);
    assert.equal(highlighted.includes(`<path>./local/file.ts${ESC}[39m`), true);
});

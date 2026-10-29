import assert from "node:assert/strict";
import { test } from "vitest";
import {
    initTheme,
    UserMessageComponent,
    type ExtensionContext,
    type SessionStartEvent,
} from "@earendil-works/pi-coding-agent";
import { getCapabilities, setCapabilityOverrides } from "@earendil-works/pi-tui";
import plainUserMessagesExtension from "../../pi-plain-user-messages/src/index.ts";
import { installUserMentionRendering } from "../../pi-mention-anything/src/message-rendering.ts";
import { highlightMessageLines } from "../src/highlight-text.ts";
import {
    installMessageHighlightPatch,
    loadMessageHighlightTargets,
} from "../src/message-highlight-patch.ts";
import { DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG } from "../src/settings.ts";

const blue = "38;2;135;215;255";
const userForeground = "38;2;222;224;225";
const mentionForeground = "38;2;167;152;215";

function glyphs(line: string) {
    let foreground = "39";
    let text = "";
    const colors: string[] = [];
    for (let index = 0; index < line.length;) {
        if (line[index] !== "\u001b") {
            text += line[index];
            colors.push(foreground);
            index += 1;
            continue;
        }
        const rest = line.slice(index);
        const osc = /^\u001b\][^\u0007\u001b]*(?:\u0007|\u001b\\)/.exec(rest);
        if (osc) {
            index += osc[0].length;
            continue;
        }
        const csi = /^\u001b\[([0-9;]*)([ -/]*[@-~])/.exec(rest);
        if (csi) {
            if (csi[2] === "m") {
                const codes = csi[1].split(";").map(Number);
                for (let i = 0; i < codes.length; i++) {
                    const code = codes[i];
                    if (code === 0 || code === 39) foreground = "39";
                    else if (code === 38 && codes[i + 1] === 2) {
                        foreground = codes.slice(i, i + 5).join(";");
                        i += 4;
                    } else if (code === 38 && codes[i + 1] === 5) {
                        foreground = codes.slice(i, i + 3).join(";");
                        i += 2;
                    } else if ((code === 48 || code === 58) && codes[i + 1] === 2) i += 4;
                    else if ((code === 48 || code === 58) && codes[i + 1] === 5) i += 2;
                    else if ((code >= 30 && code <= 37) || (code >= 90 && code <= 97))
                        foreground = String(code);
                }
            }
            index += csi[0].length;
            continue;
        }
        index += 2;
    }
    return { text, colors };
}

function assertColors(line: string, target: string, expected: string): void {
    const decoded = glyphs(line);
    const start = decoded.text.lastIndexOf(target);
    assert.notEqual(start, -1, decoded.text);
    assert.deepEqual(
        decoded.colors.slice(start, start + target.length),
        Array(target.length).fill(expected),
    );
}

test("the captured OSC/SGR nesting colors visible URL glyphs, not just a prefix", () => {
    const input = `Please review \u001b[${mentionForeground}m%staging\u001b[${userForeground}m and \u001b[39m\u001b]8;;https://example.com/docs\u001b\\\u001b[38;2;105;173;208m\u001b[4m\u001b[${userForeground}mhttps://example.com/docs\u001b[39m\u001b[24m\u001b[39m\u001b]8;;\u001b\\\u001b[${userForeground}m.`;
    assertColors(input, "https://example.com/docs", userForeground);
    const [result] = highlightMessageLines([input], { url: `\u001b[${blue}m`, filepath: "" });
    assertColors(result, "https://example.com/docs", blue);
    assertColors(result, "%staging", mentionForeground);
    assertColors(result, ".", userForeground);
});

test("real user rendering keeps mention and URL glyph colors in both patch orders", async () => {
    initTheme("dark", false);
    const originalHyperlinks = getCapabilities().hyperlinks;
    setCapabilityOverrides({ hyperlinks: true });
    const targets = await loadMessageHighlightTargets();
    assert.ok(targets);
    const shutdownHandlers: Array<() => void> = [];
    const api = {
        on(
            ...registration:
                | ["session_start", (event: SessionStartEvent, context: ExtensionContext) => void]
                | ["session_shutdown", () => void]
        ): void {
            if (registration[0] === "session_shutdown") shutdownHandlers.push(registration[1]);
        },
    };
    try {
        for (const plain of [false, true]) {
            if (plain) await plainUserMessagesExtension(api);
            for (const order of ["mention-first", "highlight-first"]) {
                const mention = () =>
                    installUserMentionRendering(
                        [
                            { id: "env", trigger: "%" },
                            { id: "web", trigger: "https:" },
                        ],
                        () => `\u001b[${mentionForeground}m`,
                    );
                const highlights = () =>
                    installMessageHighlightPatch(
                        targets,
                        DEFAULT_MESSAGE_HIGHLIGHTS_CONFIG,
                        () => undefined,
                    );
                let first;
                let second;
                if (order === "mention-first") {
                    first = mention();
                    second = highlights();
                } else {
                    first = highlights();
                    second = mention();
                }
                try {
                    const user = new UserMessageComponent(
                        "Please review %staging and https://example.com/docs.",
                        undefined,
                        1,
                    );
                    const line = user.render(100).find((entry) => entry.includes("%staging"));
                    if (line === undefined) assert.fail("Missing rendered user message");
                    assertColors(line, "%staging", mentionForeground);
                    assertColors(line, "https://example.com/docs", blue);
                    assertColors(line, ".", userForeground);
                } finally {
                    second.dispose();
                    first.dispose();
                }
            }
        }
    } finally {
        for (const shutdown of shutdownHandlers) shutdown();
        setCapabilityOverrides({ hyperlinks: originalHyperlinks });
    }
});

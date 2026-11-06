import { stripVTControlCharacters } from "node:util";
import { initTheme, ToolExecutionComponent } from "@earendil-works/pi-coding-agent";
import { Text, TuiMainScreen, visibleWidth } from "@earendil-works/pi-tui";
import { afterEach, beforeEach, expect, it } from "vitest";
import { createNativeBashFeature } from "../../src/tools/built-in/bash/preview.ts";
import {
    disposeSyntaxHighlighting,
    settleSyntaxHighlights,
} from "../../src/rendering/syntax/highlighter.ts";
import {
    configureBuiltInToolRendererPatch,
    configureThirdPartyToolRendererPatch,
} from "../../src/pi/patches/tool-execution-patch.ts";
import { call, empty, type GlowupRenderer } from "../../src/tools/protocol/contract.ts";
import { glowupRenderingAdapter } from "../../src/tools/protocol/renderer.ts";
import { jsonValueParser } from "../../src/json-value.ts";
import { VirtualTerminal } from "../support/virtual-terminal.ts";

const adapter = {
    version: 3,
    callStyle: { kind: "bash", background: true },
    parseArgs: (value) => jsonValueParser.parse(value),
    parseResult: () => ({}),
    renderCall: () => call({ static: "Owner call fallback" }),
    renderResult: () => empty(),
} satisfies GlowupRenderer<unknown, unknown>;

let bash: ReturnType<typeof createNativeBashFeature>;
let terminal: VirtualTerminal;
let tui: TuiMainScreen;

beforeEach(() => {
    initTheme("dark");
    bash = createNativeBashFeature();
    terminal = new VirtualTerminal(100, 30);
    tui = new TuiMainScreen(terminal);
    configureThirdPartyToolRendererPatch(true);
    configureBuiltInToolRendererPatch(true, {
        renderCall(name, args, theme, context) {
            if (name !== "bash") return undefined;
            return bash.renderBashCall(
                jsonValueParser.parse(args),
                theme,
                context,
                () => 8,
                () => false,
                () => "auto",
                () => "trailing",
            );
        },
        renderResult() {
            return undefined;
        },
    });
});

afterEach(async () => {
    configureBuiltInToolRendererPatch(false);
    configureThirdPartyToolRendererPatch(false);
    bash.clear();
    await bash.settled();
    await disposeSyntaxHighlighting();
    tui.stop();
    terminal.dispose();
});

function row(name: string, command: string) {
    const definition = {
        renderCall: () => new Text("Plain Pi fallback", 0, 0),
        renderResult: () => new Text("Plain Pi result", 0, 0),
        glowupRendering: adapter,
    };

    return new ToolExecutionComponent(
        name,
        `render-${name}`,
        { command },
        undefined,
        definition,
        tui,
        process.cwd(),
    );
}

function screen(component: ToolExecutionComponent, width = 80) {
    return component
        .render(width)
        .map(stripVTControlCharacters)
        .filter((line) => line.trim().length > 0);
}

it("reuses the actual native Bash call renderer for declared shell tools while retaining owner results", async () => {
    const command = "python - <<'PY'\nprint('hello world')\nPY";
    const background = row("custom_background", command);
    const foreground = new ToolExecutionComponent(
        "bash",
        "render-bash",
        { command },
        undefined,
        undefined,
        tui,
        process.cwd(),
    );
    for (const component of [background, foreground]) {
        component.setArgsComplete();
        component.updateResult({
            content: [{ type: "text", text: "private launch result" }],
            isError: false,
            durationMs: 1250,
        });
        component.render(80);
    }

    await bash.settled();
    await settleSyntaxHighlights();
    const backgroundLines = screen(background);
    const foregroundLines = screen(foreground);
    expect(backgroundLines[0]).toMatch(/\$ python.* 1\.25s\s*$/u);
    expect(backgroundLines.join("\n")).toContain("print('hello world')");
    expect(backgroundLines.join("\n")).not.toContain("private launch result");
    expect(backgroundLines.join("\n")).not.toContain("Owner call fallback");
    expect(foregroundLines.join("\n")).not.toContain("");
    expect(backgroundLines.slice(1)).toEqual(
        foregroundLines.filter((line) => !line.includes("private launch result")).slice(1),
    );

    expect(backgroundLines.every((line) => visibleWidth(line) <= 80)).toBe(true);
});

it("uses the native asynchronous formatter for declared shell calls without native Bash events", async () => {
    bash.clear();
    let formatted = 0;
    bash = createNativeBashFeature(() => async ({ code }) => {
        formatted += 1;
        return code.replace("unformatted", "formatted");
    });
    const component = row("custom_background", "python - <<'PY'\nprint('unformatted')\nPY");
    component.setArgsComplete();
    component.updateResult({ content: [], isError: false, durationMs: 25 });
    screen(component);
    await bash.settled();
    screen(component);
    await bash.settled();

    const completedFormats = formatted;
    const rendered = screen(component).join("\n");
    expect(rendered).toContain("print('formatted')");
    expect(rendered).not.toContain("unformatted");
    expect(rendered).toContain("");
    await bash.settled();
    expect(formatted).toBe(completedFormats);
});

it("preserves an explicitly preserved tool instead of applying its Bash call style", () => {
    configureThirdPartyToolRendererPatch(true, { preserveTools: ["custom_background"] });
    const component = row("custom_background", "printf hello");
    component.setArgsComplete();
    component.updateResult({ content: [], isError: false, durationMs: 12 });
    expect(screen(component).join("\n")).toContain("Plain Pi fallback");
    expect(screen(component).join("\n")).not.toContain("");
});

it("falls back to the tool's own rendering when Glowup patches are disabled", () => {
    configureBuiltInToolRendererPatch(false);
    configureThirdPartyToolRendererPatch(false);
    const component = row("custom_background", "printf hello");
    component.setArgsComplete();
    expect(screen(component).join("\n")).toContain("Plain Pi fallback");
});

it.each([
    { kind: "other", background: true },
    { kind: "bash", background: "true" },
])("rejects malformed native Bash rendering metadata: %j", (callStyle) => {
    expect(glowupRenderingAdapter({ glowupRendering: { ...adapter, callStyle } })).toBeUndefined();
});

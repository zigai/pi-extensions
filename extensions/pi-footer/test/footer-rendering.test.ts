import assert from "node:assert/strict";
import { test } from "vitest";

import { visibleWidth } from "@earendil-works/pi-tui";
import { registerFooterSlot } from "@zigai/pi-footer/api";
import { createFooterComponent } from "../src/footer-rendering.ts";
import { DEFAULT_FOOTER_CONFIG } from "../src/settings.ts";
import type { GitAheadBehindSource } from "../src/git-ahead-behind.ts";
import type { FooterContext, FooterData } from "../src/footer-model.ts";

const ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const BACKGROUND_ANSI_PATTERN = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*48;2;`);

function stripAnsi(value: string): string {
    return value.replace(ANSI_PATTERN, "");
}

function footerContext(): FooterContext {
    return {
        cwd: "/workspace/pi-tweaks",
        model: {
            provider: "github-copilot",
            id: "gpt-5",
            contextWindow: 200_000,
        },
        getContextUsage() {
            return {
                tokens: 150_000,
                percent: 75,
                contextWindow: 200_000,
            };
        },
        mcpServers: [{}, {}],
        modelRegistry: {
            getProviderDisplayName(provider: string) {
                if (provider === "github-copilot") return "copilot";
                return provider;
            },
        },
    };
}

function footerData(branch: string | null, statuses: ReadonlyMap<string, string>): FooterData {
    return {
        getGitBranch() {
            return branch;
        },
        getExtensionStatuses() {
            return statuses;
        },
        onBranchChange() {
            return () => undefined;
        },
    };
}

test("createFooterComponent renders key session status without exceeding width", () => {
    const component = createFooterComponent(
        footerContext(),
        footerData("main", new Map([["mcp", "MCP:\n 2\tservers"]])),
        () => "medium",
        () => undefined,
        {
            ...DEFAULT_FOOTER_CONFIG,
            layout: {
                left: DEFAULT_FOOTER_CONFIG.layout.left,
                right: ["mcp", "context"],
                hidden: DEFAULT_FOOTER_CONFIG.layout.hidden,
            },
        },
    );

    const line = component.render(120)[0] ?? "";
    const plain = stripAnsi(line);
    assert.equal(visibleWidth(line) <= 118, true);
    assert.match(plain, /\/workspace\/pi-tweaks/);
    assert.match(plain, /main/);
    assert.match(plain, /copilot/);
    assert.match(plain, /gpt-5/);
    assert.match(plain, /medium/);
    assert.match(plain, /75\.0%\/200k/);
    assert.match(plain, /MCP: 2 servers/);
});

test("createFooterComponent leaves plain footer background transparent", () => {
    const theme = {
        fg(role: "muted" | "dim", text: string): string {
            return `<${role}>${text}</${role}>`;
        },
    };
    const component = createFooterComponent(
        footerContext(),
        footerData("main", new Map()),
        () => "medium",
        () => undefined,
        DEFAULT_FOOTER_CONFIG,
        theme,
    );

    const line = component.render(120)[0] ?? "";
    assert.doesNotMatch(line, BACKGROUND_ANSI_PATTERN);
    assert.match(line, /<muted>.*\/workspace\/pi-tweaks.*<\/muted>/);
    assert.match(line, /<dim> · <\/dim>/);
});

test("createFooterComponent renders configured plain separator on both sides", () => {
    const component = createFooterComponent(
        footerContext(),
        footerData("main", new Map()),
        () => "medium",
        () => undefined,
        {
            ...DEFAULT_FOOTER_CONFIG,
            separator: "/",
            layout: { ...DEFAULT_FOOTER_CONFIG.layout, right: ["mcp", "context"] },
        },
    );

    const line = component.render(120)[0] ?? "";
    const plain = stripAnsi(line);
    assert.match(plain, /pi-tweaks \/ .*main \/ .*copilot \/ .*gpt-5 \/ .*medium/);
    assert.doesNotMatch(plain, / · /);
    assert.match(plain, /MCP: 2 servers \/ 75\.0%\/200k/);
});

test("createFooterComponent renders git ahead and behind counts beside the branch", () => {
    let disposed = false;
    const gitAheadBehindSource: GitAheadBehindSource = {
        getGitAheadBehind() {
            return { ahead: 3, behind: 2 };
        },
        refresh() {},
        dispose() {
            disposed = true;
        },
    };
    const component = createFooterComponent(
        footerContext(),
        footerData("main", new Map()),
        () => "medium",
        () => undefined,
        { ...DEFAULT_FOOTER_CONFIG, showGitAheadBehind: true },
        undefined,
        gitAheadBehindSource,
    );

    const line = component.render(120)[0] ?? "";
    const plain = stripAnsi(line);
    assert.match(plain, /main ↑3 ↓2/);
    component.dispose();
    assert.equal(disposed, true);
});

test("createFooterComponent prefers model display names over model ids", () => {
    const ctx: FooterContext = {
        cwd: "/workspace/pi-tweaks",
        model: {
            provider: "openai-codex",
            id: "gpt-5.5",
            name: "GPT-5.5",
            contextWindow: 200_000,
        },
        getContextUsage() {
            return {
                tokens: 150_000,
                percent: 75,
                contextWindow: 200_000,
            };
        },
    };
    const component = createFooterComponent(
        ctx,
        footerData(null, new Map()),
        () => "medium",
        () => undefined,
    );

    const line = component.render(120)[0] ?? "";
    const plain = stripAnsi(line);
    assert.match(plain, /GPT-5\.5/);
    assert.doesNotMatch(plain, /gpt-5\.5/);
});

test("createFooterComponent uses provider display names from the model registry", () => {
    const ctx: FooterContext = {
        cwd: "/workspace/pi-tweaks",
        model: {
            provider: "openai-codex",
            id: "gpt-5",
            contextWindow: 200_000,
        },
        modelRegistry: {
            getProviderDisplayName(provider: string) {
                if (provider === "openai-codex") return "Codex";
                return provider;
            },
        },
        getContextUsage() {
            return {
                tokens: 150_000,
                percent: 75,
                contextWindow: 200_000,
            };
        },
    };
    const component = createFooterComponent(
        ctx,
        footerData(null, new Map()),
        () => "medium",
        () => undefined,
    );

    const line = component.render(120)[0] ?? "";
    const plain = stripAnsi(line);
    assert.match(plain, /Codex/);
    assert.doesNotMatch(plain, /openai-codex/);
});

test("createFooterComponent uses snapshotted provider display names", () => {
    const ctx: FooterContext = {
        cwd: "/workspace/pi-tweaks",
        model: {
            provider: "openai-codex",
            providerDisplayName: "Codex",
            id: "gpt-5",
            contextWindow: 200_000,
        },
        getContextUsage() {
            return {
                tokens: 150_000,
                percent: 75,
                contextWindow: 200_000,
            };
        },
    };
    const component = createFooterComponent(
        ctx,
        footerData(null, new Map()),
        () => "medium",
        () => undefined,
    );

    const line = component.render(120)[0] ?? "";
    const plain = stripAnsi(line);
    assert.match(plain, /Codex/);
    assert.doesNotMatch(plain, /openai-codex/);
});

test("createFooterComponent preserves the primary path and drops optional narrow segments", () => {
    const component = createFooterComponent(
        footerContext(),
        footerData("feature/very-long-branch", new Map([["mcp", "MCP: connected"]])),
        () => "high",
        () => undefined,
    );

    const line = component.render(30)[0] ?? "";
    const plain = stripAnsi(line);
    assert.equal(visibleWidth(line) <= 28, true);
    assert.equal(plain.trim(), "/workspace/pi-tweaks");
    assert.doesNotMatch(plain, /feature\/very-long-branch/);
    assert.doesNotMatch(plain, /copilot/);
    assert.doesNotMatch(plain, /gpt-5/);
    assert.doesNotMatch(plain, /high/);
    assert.doesNotMatch(plain, /75\.0%\/200k/);
    assert.doesNotMatch(plain, /MCP: connected/);
});

test("createFooterComponent renders configured layout order and omissions", () => {
    const component = createFooterComponent(
        footerContext(),
        footerData("main", new Map([["mcp", "MCP: connected"]])),
        () => "medium",
        () => undefined,
        {
            ...DEFAULT_FOOTER_CONFIG,
            layout: {
                left: ["model", "provider"],
                right: [],
                hidden: [],
            },
        },
    );

    const line = component.render(120)[0] ?? "";
    const plain = stripAnsi(line);
    assert.match(plain, /gpt-5 · copilot/);
    assert.doesNotMatch(plain, /\/workspace\/pi-tweaks/);
    assert.doesNotMatch(plain, /main/);
    assert.doesNotMatch(plain, /medium/);
    assert.doesNotMatch(plain, /MCP: connected/);
    assert.doesNotMatch(plain, /75\.0%\/200k/);
});

test("createFooterComponent renders custom API slots and updates on text changes", () => {
    const handle = registerFooterSlot({
        id: "test-footer.status",
        defaultSide: "right",
        text: "ready",
    });
    let renderRequests = 0;

    try {
        const component = createFooterComponent(
            footerContext(),
            footerData(null, new Map()),
            () => "medium",
            () => {
                renderRequests += 1;
            },
        );

        let line = component.render(120)[0] ?? "";
        let plain = stripAnsi(line);
        assert.match(plain, /ready/);
        handle.setText("working\nnow");
        assert.equal(renderRequests, 1);
        line = component.render(120)[0] ?? "";
        plain = stripAnsi(line);
        assert.match(plain, /working now/);
        handle.clear();
        assert.equal(renderRequests, 2);
        line = component.render(120)[0] ?? "";
        plain = stripAnsi(line);
        assert.doesNotMatch(plain, /working now/);
        component.dispose();
    } finally {
        handle.dispose();
    }
});

test("createFooterComponent places explicit custom API slots from config", () => {
    const handle = registerFooterSlot({
        id: "test-footer.explicit",
        text: "custom",
    });

    try {
        const component = createFooterComponent(
            footerContext(),
            footerData(null, new Map()),
            () => "medium",
            () => undefined,
            {
                ...DEFAULT_FOOTER_CONFIG,
                layout: {
                    left: ["test-footer.explicit", "path"],
                    right: [],
                    hidden: [],
                },
            },
        );

        const line = component.render(120)[0] ?? "";
        const plain = stripAnsi(line);
        assert.match(plain.trim(), /^custom · \/workspace\/pi-tweaks/);
    } finally {
        handle.dispose();
    }
});

test("createFooterComponent hides custom API slots through config", () => {
    const handle = registerFooterSlot({
        id: "test-footer.hidden",
        defaultSide: "right",
        text: "hidden custom",
    });

    try {
        const component = createFooterComponent(
            footerContext(),
            footerData(null, new Map()),
            () => "medium",
            () => undefined,
            {
                ...DEFAULT_FOOTER_CONFIG,
                layout: {
                    left: DEFAULT_FOOTER_CONFIG.layout.left,
                    right: DEFAULT_FOOTER_CONFIG.layout.right,
                    hidden: ["test-footer.hidden"],
                },
            },
        );

        const line = component.render(120)[0] ?? "";
        const plain = stripAnsi(line);
        assert.doesNotMatch(plain, /hidden custom/);
    } finally {
        handle.dispose();
    }
});

test("createFooterComponent disposes the branch-change subscription", () => {
    let unsubscribed = false;
    const data: FooterData = {
        getGitBranch() {
            return null;
        },
        getExtensionStatuses() {
            return new Map();
        },
        onBranchChange() {
            return () => {
                unsubscribed = true;
            };
        },
    };

    const component = createFooterComponent(
        footerContext(),
        data,
        () => "off",
        () => undefined,
    );
    component.dispose();
    assert.equal(unsubscribed, true);
});

import assert from "node:assert/strict";
import { test } from "vitest";
import { SessionManager, type ToolInfo } from "@earendil-works/pi-coding-agent";

import {
    getFooterRoute,
    getNativeMcpServerCount,
    isApiKeyBilled,
    sumSessionCost,
} from "../src/footer-session-status.ts";
import type { FooterContext } from "../src/footer-model.ts";
import { createFooterComponent } from "../src/footer-rendering.ts";
import { DEFAULT_FOOTER_CONFIG } from "../src/settings.ts";

function nativeTool(namespace: string, exposure: ToolInfo["exposure"] = "codemode") {
    return {
        sourceInfo: {
            path: "builtin:mcp",
            source: "builtin",
            scope: "user",
            origin: "top-level",
        } as const,
        namespace: { name: namespace },
        exposure,
    };
}

function routeContext(sessionManager: SessionManager): FooterContext {
    return {
        cwd: "/workspace",
        model: { api: "pi-virtual", provider: "router", id: "auto" },
        sessionManager,
        getContextUsage: () => undefined,
    };
}

function appendResponse(session: SessionManager, stopReason: "stop" | "error" | "aborted") {
    return session.appendMessage({
        role: "assistant",
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5",
        thinkingLevel: "high",
        content: [{ type: "text", text: "response" }],
        usage: {
            input: 1,
            output: 1,
            cacheRead: 0,
            cacheWrite: 0,
            totalTokens: 2,
            cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
        },
        stopReason,
        timestamp: 1,
    });
}

test("counts native MCP namespaces without hidden or non-MCP tools", () => {
    assert.equal(
        getNativeMcpServerCount([
            nativeTool("alpha"),
            nativeTool("alpha", "deferred"),
            nativeTool("beta", "direct"),
            nativeTool("withdrawn", "hidden"),
            {
                ...nativeTool("other"),
                sourceInfo: {
                    path: "/extension.ts",
                    source: "local",
                    scope: "user",
                    origin: "top-level",
                },
            },
        ]),
        2,
    );
    assert.equal(getNativeMcpServerCount([nativeTool("withdrawn", "hidden")]), undefined);
});

test("shows only canonical successful routing responses under virtual selections", () => {
    const session = SessionManager.inMemory("/workspace");
    const response = appendResponse(session, "stop");
    appendResponse(session, "error");
    appendResponse(session, "aborted");
    const ctx = routeContext(session);
    assert.deepEqual(getFooterRoute(ctx), {
        provider: "openai",
        id: "gpt-5",
        thinkingLevel: "high",
    });

    session.appendContextEdit(response, null);
    assert.equal(getFooterRoute(ctx), undefined);
    assert.equal(
        getFooterRoute({
            ...ctx,
            model: { api: "openai-responses", provider: "openai", id: "gpt-5" },
        }),
        undefined,
    );
});

test("renders native MCP inventory and the dispatched physical model", () => {
    const session = SessionManager.inMemory("/workspace");
    appendResponse(session, "stop");
    let tools = [nativeTool("alpha"), nativeTool("beta")];
    const component = createFooterComponent(
        { ...routeContext(session), getMcpServerCount: () => getNativeMcpServerCount(tools) },
        {
            getGitBranch: () => null,
            getExtensionStatuses: () => new Map(),
            onBranchChange: () => () => undefined,
        },
        () => "medium",
        () => undefined,
        { ...DEFAULT_FOOTER_CONFIG, layout: { left: ["model", "mcp"], right: [], hidden: [] } },
    );
    assert.match(component.render(120).join(""), /auto → gpt-5 • high.*MCP: 2 servers/);
    tools = [];
    assert.doesNotMatch(component.render(120).join(""), /MCP:/);
});

function usageCosting(total: number) {
    return {
        input: 1,
        output: 1,
        cacheRead: 0,
        cacheWrite: 0,
        totalTokens: 2,
        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total },
    };
}

test("sums session cost across responses, usage records, and summaries", () => {
    const session = SessionManager.inMemory("/workspace");
    const first = session.appendMessage({
        role: "assistant",
        api: "openai-responses",
        provider: "openai",
        model: "gpt-5",
        content: [{ type: "text", text: "response" }],
        usage: usageCosting(0.25),
        stopReason: "stop",
        timestamp: 1,
    });
    session.appendUsage("cache_warm", "openai", "gpt-5", usageCosting(0.5));
    session.branchWithSummary(first, "summary", undefined, false, usageCosting(1));
    assert.equal(sumSessionCost(session.getEntries()), 1.75);
});

test("treats only API-key authenticated models as API billed", () => {
    const apiModel = { provider: "openai", id: "gpt-5" };
    const oauthModel = { provider: "openai-codex", id: "gpt-5.2-codex" };
    const modelRegistry = {
        find: (provider: string, id: string) =>
            [apiModel, oauthModel].find((model) => model.provider === provider && model.id === id),
        isUsingOAuth: (model: { provider: string }) => model.provider === "openai-codex",
    };

    assert.equal(isApiKeyBilled({ model: apiModel, modelRegistry }, undefined), true);
    assert.equal(isApiKeyBilled({ model: oauthModel, modelRegistry }, undefined), false);
    assert.equal(isApiKeyBilled({ model: undefined, modelRegistry }, undefined), false);
    assert.equal(
        isApiKeyBilled(
            { model: apiModel, modelRegistry },
            { provider: "openai-codex", id: "gpt-5.2-codex" },
        ),
        false,
    );
});

test("renders session cost on the right only when it is reported", () => {
    let cost: number | undefined = 1.25;
    const component = createFooterComponent(
        {
            cwd: "/workspace",
            model: { provider: "openai", id: "gpt-5" },
            getContextUsage: () => ({ tokens: 10, percent: 5, contextWindow: 200 }),
            getApiSessionCost: () => cost,
        },
        {
            getGitBranch: () => null,
            getExtensionStatuses: () => new Map(),
            onBranchChange: () => () => undefined,
        },
        () => "medium",
        () => undefined,
    );
    assert.match(component.render(120).join(""), /\$1\.25 · 5\.0%\/200 $/);
    cost = undefined;
    assert.doesNotMatch(component.render(120).join(""), /\$/);
});

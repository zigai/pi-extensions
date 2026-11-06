import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
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

function countedRouteContext(session: SessionManager) {
    let projections = 0;
    const buildSessionProjection = session.buildSessionProjection.bind(session);
    session.buildSessionProjection = () => {
        projections += 1;
        return buildSessionProjection();
    };
    const context = routeContext(session);

    return { context, projections: () => projections };
}

test("unchanged footer routes reuse only route data, not the full session projection", () => {
    const session = SessionManager.inMemory("/workspace");
    appendResponse(session, "stop");
    const counted = countedRouteContext(session);
    for (let index = 0; index < 20; index += 1)
        assert.equal(getFooterRoute(counted.context)?.id, "gpt-5");

    assert.equal(counted.projections(), 1);
    const route = getFooterRoute(counted.context);
    if (route === undefined) throw new Error("Expected routed model");

    route.id = "caller mutation";
    assert.equal(getFooterRoute(counted.context)?.id, "gpt-5");
    assert.equal(counted.projections(), 1);
});

test("missing routes are cached until canonical session state advances", () => {
    const session = SessionManager.inMemory("/workspace");
    const counted = countedRouteContext(session);
    assert.equal(getFooterRoute(counted.context), undefined);
    assert.equal(getFooterRoute(counted.context), undefined);
    assert.equal(counted.projections(), 1);
    const response = appendResponse(session, "stop");
    assert.equal(getFooterRoute(counted.context)?.id, "gpt-5");
    assert.equal(counted.projections(), 2);
    session.appendContextEdit(response, null);
    assert.equal(getFooterRoute(counted.context), undefined);
    assert.equal(getFooterRoute(counted.context), undefined);
    assert.equal(counted.projections(), 3);
});

test("route caches follow branch navigation, manager replacement, and explicit overrides", () => {
    const session = SessionManager.inMemory("/workspace");
    const first = appendResponse(session, "stop");
    session.appendContextEdit(first, null);
    const hidden = session.getLeafId();
    if (hidden === null) throw new Error("Expected context edit leaf");

    const counted = countedRouteContext(session);
    assert.equal(getFooterRoute(counted.context), undefined);
    session.branch(first);
    assert.equal(getFooterRoute(counted.context)?.id, "gpt-5");
    session.branch(hidden);
    assert.equal(getFooterRoute(counted.context), undefined);
    session.branch(first);
    assert.equal(getFooterRoute(counted.context)?.id, "gpt-5");
    assert.equal(counted.projections(), 4);
    counted.context.routedModel = { provider: "explicit", id: "snapshot" };
    assert.equal(getFooterRoute(counted.context)?.id, "snapshot");
    assert.equal(counted.projections(), 4);
    counted.context.routedModel = undefined;
    counted.context.sessionManager = SessionManager.inMemory("/other-workspace");
    assert.equal(getFooterRoute(counted.context), undefined);
});

test("projection-only footer contexts retain uncached live lookup", () => {
    const session = SessionManager.inMemory("/workspace");
    let projections = 0;
    const context: FooterContext = {
        ...routeContext(session),
        sessionManager: {
            buildSessionProjection() {
                projections += 1;
                return session.buildSessionProjection();
            },
        },
    };
    assert.equal(getFooterRoute(context), undefined);
    appendResponse(session, "stop");
    assert.equal(getFooterRoute(context)?.id, "gpt-5");
    assert.equal(getFooterRoute(context)?.id, "gpt-5");
    assert.equal(projections, 3);
});

test("cached routes follow resetLeaf and newSession on the same SDK manager", () => {
    const session = SessionManager.inMemory("/workspace");
    const counted = countedRouteContext(session);
    const response = appendResponse(session, "stop");
    assert.equal(getFooterRoute(counted.context)?.id, "gpt-5");
    assert.equal(getFooterRoute(counted.context)?.id, "gpt-5");
    assert.equal(counted.projections(), 1);
    session.resetLeaf();
    assert.equal(getFooterRoute(counted.context), undefined);
    assert.equal(getFooterRoute(counted.context), undefined);
    assert.equal(counted.projections(), 2);

    // Both revisions have a null leaf; only the session ID changes here.
    const oldSessionId = session.getSessionId();
    session.newSession();
    assert.notEqual(session.getSessionId(), oldSessionId);
    assert.equal(session.getLeafId(), null);
    assert.equal(counted.context.sessionManager, session);
    assert.equal(getFooterRoute(counted.context), undefined);
    assert.equal(getFooterRoute(counted.context), undefined);
    assert.equal(counted.projections(), 3);
    assert.equal(session.getEntry(response), undefined);
    appendResponse(session, "stop");
    assert.equal(getFooterRoute(counted.context)?.id, "gpt-5");
    assert.equal(counted.projections(), 4);
    session.newSession();
    assert.equal(getFooterRoute(counted.context), undefined);
    assert.equal(counted.projections(), 5);
});

test("compaction invalidates a cached route when its successful response leaves context", () => {
    const session = SessionManager.inMemory("/workspace");
    appendResponse(session, "stop");
    const kept = session.appendMessage({ role: "user", content: "Continue", timestamp: 2 });
    const counted = countedRouteContext(session);
    assert.equal(getFooterRoute(counted.context)?.id, "gpt-5");
    assert.equal(getFooterRoute(counted.context)?.id, "gpt-5");
    assert.equal(counted.projections(), 1);
    session.appendCompaction("Earlier response summarized", kept, 100);

    // The SDK also projects internally to preserve its current system message.
    const afterCompaction = counted.projections();
    assert.equal(getFooterRoute(counted.context), undefined);
    assert.equal(getFooterRoute(counted.context), undefined);
    assert.equal(counted.projections(), afterCompaction + 1);
    appendResponse(session, "stop");
    assert.equal(getFooterRoute(counted.context)?.id, "gpt-5");
    assert.equal(counted.projections(), afterCompaction + 2);
});

test("route cache releases managers and full projections while its context stays live", () => {
    const statusModule = new URL("../src/footer-session-status.ts", import.meta.url).href;
    const child = spawnSync(
        process.execPath,
        [
            "--expose-gc",
            "--input-type=module",
            "-e",
            `
            import assert from 'node:assert/strict';
            import { SessionManager } from '@earendil-works/pi-coding-agent';
            const { getFooterRoute } = await import(${JSON.stringify(statusModule)});

            function populatedContext() {
                const manager = SessionManager.inMemory('/workspace');
                manager.appendMessage({
                    role: 'assistant', api: 'openai-responses', provider: 'openai', model: 'gpt-5',
                    content: [{ type: 'text', text: 'large response '.repeat(10000) }],
                    usage: {
                        input: 1, output: 1, cacheRead: 0, cacheWrite: 0, totalTokens: 2,
                        cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
                    },
                    stopReason: 'stop', timestamp: 1,
                });
                const refs = [];
                const build = manager.buildSessionProjection;
                // The observer closes over only weak references and the SDK method,
                // never the manager or a full projection after this call returns.
                manager.buildSessionProjection = function () {
                    const projection = build.call(this);
                    refs.push({
                        projection: new WeakRef(projection),
                        messages: new WeakRef(projection.messages),
                        entries: new WeakRef(projection.entries),
                        message: new WeakRef(projection.messages[0]),
                    });
                    return projection;
                };
                const context = {
                    cwd: '/workspace', model: { api: 'pi-virtual', provider: 'router', id: 'auto' },
                    sessionManager: manager, getContextUsage: () => undefined,
                };
                assert.equal(getFooterRoute(context)?.id, 'gpt-5');
                assert.equal(getFooterRoute(context)?.id, 'gpt-5');
                assert.equal(refs.length, 1, 'route was not cached');
                return { context, manager: new WeakRef(manager), refs };
            }

            for (const release of ['clear', 'replace']) {
                const fixture = populatedContext();
                await new Promise(resolve => setImmediate(resolve));
                global.gc();
                // Keep the actual context and manager alive while checking that only
                // route scalars, not projection containers, survive cached lookups.
                assert.equal(fixture.manager.deref(), fixture.context.sessionManager);
                for (const refs of fixture.refs) {
                    assert.equal(refs.projection.deref(), undefined, 'full projection retained');
                    assert.equal(refs.messages.deref(), undefined, 'projected messages retained');
                    assert.equal(refs.entries.deref(), undefined, 'projected entries retained');
                    assert.ok(refs.message.deref(), 'manager should still own its message');
                }
                if (release === 'clear') fixture.context.sessionManager = undefined;
                else fixture.context.sessionManager = SessionManager.inMemory('/replacement');
                // Do not look up the route yet: the old revision must remain cached
                // under the live context throughout GC. Cross another job boundary
                // after deref(), which itself protects targets until the job ends.
                await new Promise(resolve => setImmediate(resolve));
                global.gc();
                assert.equal(fixture.manager.deref(), undefined, release + ': manager retained');
                for (const refs of fixture.refs) {
                    assert.equal(refs.message.deref(), undefined, release + ': full message retained');
                }
                assert.equal(getFooterRoute(fixture.context), undefined);
                assert.equal(fixture.context.cwd, '/workspace');
            }
        `,
        ],
        { encoding: "utf8", timeout: 20_000 },
    );
    assert.equal(child.status, 0, child.stderr);
});

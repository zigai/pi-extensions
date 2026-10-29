import { afterEach, describe, expect, it, vi } from "vitest";
import { openRouterSchedule, openRouterRoute } from "../src/openrouter-peak.ts";

const model = {
    provider: "openrouter",
    id: "deepseek/deepseek-v4-pro-0813",
    api: "openai-completions",
    baseUrl: "https://openrouter.ai/api/v1",
    compat: { openRouterRouting: { only: ["alibaba/us-east-1"], allow_fallbacks: false } },
};
const prices = (prompt: string) => ({ prompt, completion: prompt, input_cache_read: prompt });
const payload = {
    data: {
        id: model.id,
        endpoints: [
            {
                tag: "alibaba/us-east-1",
                status: 0,
                pricing: {
                    ...prices("2"),
                    overrides: [
                        { utc_start: 0, utc_end: 1400, ...prices("2") },
                        { utc_start: 1400, utc_end: 0, ...prices("1") },
                    ],
                },
            },
        ],
    },
};

describe("OpenRouter picker offer", () => {
    it("requires an exact OpenRouter route with no fallback", () => {
        expect(openRouterRoute(model)).toEqual({
            model: model.id,
            tag: "alibaba/us-east-1",
            schedule: "ali-deepseek",
        });

        expect(
            openRouterRoute({
                ...model,
                compat: { openRouterRouting: { only: ["alibaba/us-east-1"] } },
            }),
        ).toBeUndefined();

        expect(
            openRouterRoute({
                ...model,
                compat: {
                    openRouterRouting: {
                        only: ["alibaba/us-east-1", "deepseek"],
                        allow_fallbacks: false,
                    },
                },
            }),
        ).toBeUndefined();

        expect(openRouterRoute({ ...model, baseUrl: "https://proxy.invalid" })).toBeUndefined();
        expect(openRouterRoute({ ...model, id: `${model.id}:nitro` })).toBeUndefined();
    });

    it("allows Flash 1017 only with the confirmed exact upstream and verified live prices", () => {
        const id = "deepseek/deepseek-v4.1-flash-1017";
        const routed = {
            ...model,
            id,
            compat: { openRouterRouting: { only: ["alibaba"], allow_fallbacks: false } },
        };
        const route = openRouterRoute(routed);
        expect(route).toEqual({ model: id, tag: "alibaba", schedule: "ali-deepseek" });

        if (!route) throw new Error("expected valid route");

        const endpoint = payload.data.endpoints[0];
        expect(
            openRouterSchedule(
                { data: { id, endpoints: [{ ...endpoint, tag: "alibaba" }] } },
                route,
            ),
        ).toBe("ali-deepseek");

        expect(
            openRouterSchedule(
                {
                    data: {
                        id,
                        endpoints: [{ ...endpoint, tag: "alibaba", pricing: { ...prices("1") } }],
                    },
                },
                route,
            ),
        ).toBeUndefined();

        expect(
            openRouterRoute({
                ...routed,
                compat: { openRouterRouting: { only: ["alibaba"], allow_fallbacks: true } },
            }),
        ).toBeUndefined();

        expect(openRouterRoute({ ...routed, id: "deepseek/deepseek-v4.1-flash" })).toBeUndefined();
        expect(
            openRouterRoute({
                ...routed,
                compat: { openRouterRouting: { only: ["deepseek"], allow_fallbacks: false } },
            }),
        ).toEqual({ model: id, tag: "deepseek", schedule: "deepseek-reseller" });
    });

    it("rejects ambiguous cross-midnight day semantics", () => {
        const route = openRouterRoute(model);
        if (!route) throw new Error("expected valid route");

        const endpoint = payload.data.endpoints[0];
        const response = {
            data: {
                ...payload.data,
                endpoints: [
                    {
                        ...endpoint,
                        pricing: {
                            ...endpoint.pricing,
                            overrides: [
                                { utc_start: 2300, utc_end: 100, ...prices("2") },
                                ...endpoint.pricing.overrides,
                            ],
                        },
                    },
                ],
            },
        };
        expect(openRouterSchedule(response, route)).toBeUndefined();
    });

    it("rejects sampling parameters that would overwrite the routed provider or model", () => {
        expect(
            openRouterRoute({ ...model, samplingParams: { provider: { only: ["other"] } } }),
        ).toBeUndefined();

        expect(
            openRouterRoute({
                ...model,
                samplingParamsByThinkingLevel: { high: { model: "other" } },
            }),
        ).toBeUndefined();
    });

    it("rejects other sampling payload overrides rather than assuming they cannot change routing", () => {
        expect(
            openRouterRoute({ ...model, samplingParams: { models: ["other"] } }),
        ).toBeUndefined();
    });

    it("requires live available exact endpoint and complete cheaper time pricing", () => {
        const route = openRouterRoute(model);
        expect(route).toBeDefined();

        if (!route) throw new Error("expected valid route");

        expect(openRouterSchedule(payload, route)).toBe("ali-deepseek");
        expect(
            openRouterSchedule({ data: { ...payload.data, endpoints: [] } }, route),
        ).toBeUndefined();

        expect(
            openRouterSchedule(
                {
                    data: {
                        ...payload.data,
                        endpoints: [{ ...payload.data.endpoints[0], status: -2 }],
                    },
                },
                route,
            ),
        ).toBeUndefined();

        expect(
            openRouterSchedule(
                {
                    data: {
                        ...payload.data,
                        endpoints: [
                            {
                                ...payload.data.endpoints[0],
                                pricing: {
                                    ...prices("2"),
                                    overrides: [{ utc_start: 0, utc_end: 1400, ...prices("2") }],
                                },
                            },
                        ],
                    },
                },
                route,
            ),
        ).toBeUndefined();

        expect(
            openRouterSchedule(
                {
                    data: {
                        ...payload.data,
                        endpoints: [
                            {
                                ...payload.data.endpoints[0],
                                pricing: {
                                    ...prices("2"),
                                    overrides: [
                                        { utc_start: 0, utc_end: 1400, ...prices("2") },
                                        {
                                            utc_start: 1400,
                                            utc_end: 0,
                                            ...prices("1"),
                                            min_context: 123,
                                        },
                                    ],
                                },
                            },
                        ],
                    },
                },
                route,
            ),
        ).toBeUndefined();
    });
});

import { Text } from "@earendil-works/pi-tui";
import { installModelSelectorPeakPatch } from "../src/model-selector-peak.ts";

class Selector {
    filteredModels = [{ model }];
    selectedIndex = 0;
    closed = false;
    listContainer = { children: [new Text("  DeepSeek [OpenRouter]", 0, 0)] };
    tui = { requestRender() {} };

    updateList() {
        this.listContainer.children = [new Text("  DeepSeek [OpenRouter]", 0, 0)];
    }

    dispose() {
        this.closed = true;
    }
}

const rendered = (selector: Selector) =>
    selector.listContainer.children[0].render(120).join("").trimEnd();
afterEach(() => vi.useRealTimers());

describe("OpenRouter picker integration", () => {
    it("shows no claim until fresh endpoint data confirms the configured route", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-05T15:00:00Z"));

        // oxlint-disable-next-line antislop/no-unknown-parameters -- Simulate the untrusted HTTP response boundary.
        let resolve: (value: unknown) => void = () => {};
        const pending = new Promise<unknown>((done) => {
            resolve = done;
        });
        const handle = installModelSelectorPeakPatch(
            {
                offPeakRules: [
                    {
                        provider: "openrouter",
                        model: model.id,
                        schedule: "or",
                        openRouterBillingConfirmed: true,
                    },
                ],
                deepseekHolidayCalendar: [],
            },
            () => ({ fg: (_color, value) => value }),
            Selector.prototype,
            async () => pending,
        );
        const selector = new Selector();
        selector.updateList();
        expect(rendered(selector)).toBe("  DeepSeek [OpenRouter]");
        resolve(payload);
        await vi.advanceTimersByTimeAsync(0);
        expect(rendered(selector)).toBe("  DeepSeek [OpenRouter]  off-peak · ends in 9h");
        selector.dispose();
        handle.dispose();
    });

    it("hides stale prices and aborts the in-flight refresh when the picker closes", async () => {
        vi.useFakeTimers();
        vi.setSystemTime(new Date("2026-01-05T15:00:00Z"));
        let count = 0;
        let active: AbortSignal | undefined;
        const handle = installModelSelectorPeakPatch(
            {
                offPeakRules: [
                    {
                        provider: "openrouter",
                        model: model.id,
                        schedule: "or",
                        openRouterBillingConfirmed: true,
                    },
                ],
                deepseekHolidayCalendar: [],
            },
            () => ({ fg: (_color, value) => value }),
            Selector.prototype,
            async (_url, signal) => {
                count += 1;
                active = signal;

                if (count === 1) return payload;
                return new Promise(() => {});
            },
        );
        const selector = new Selector();
        selector.updateList();
        await vi.advanceTimersByTimeAsync(0);
        expect(rendered(selector)).toBe("  DeepSeek [OpenRouter]  off-peak · ends in 9h");
        await vi.advanceTimersByTimeAsync(60_000);
        expect(count).toBe(2);
        expect(rendered(selector)).toBe("  DeepSeek [OpenRouter]");
        selector.dispose();
        expect(active?.aborted).toBe(true);
        handle.dispose();
    });
});

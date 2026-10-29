import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

const SamplingParams = Type.Record(Type.String(), Type.Unknown());
const RoutingModel = Type.Object({
    provider: Type.Literal("openrouter"),
    id: Type.String(),
    api: Type.Literal("openai-completions"),
    baseUrl: Type.Literal("https://openrouter.ai/api/v1"),
    samplingParams: Type.Optional(SamplingParams),
    samplingParamsByThinkingLevel: Type.Optional(Type.Record(Type.String(), SamplingParams)),
    compat: Type.Object({
        openRouterRouting: Type.Object({
            allow_fallbacks: Type.Literal(false),
            only: Type.Array(Type.String(), { minItems: 1, maxItems: 1 }),
        }),
    }),
});

const OverrideSchema = Type.Object(
    {
        utc_start: Type.Optional(Type.Integer({ minimum: 0, maximum: 2359 })),
        utc_end: Type.Optional(Type.Integer({ minimum: 0, maximum: 2359 })),
        utc_days: Type.Optional(Type.Array(Type.String(), { minItems: 1 })),
        prompt: Type.String(),
        completion: Type.String(),
        input_cache_read: Type.String(),
    },
    { additionalProperties: false },
);

const ResponseSchema = Type.Object({
    data: Type.Object({
        id: Type.String(),
        endpoints: Type.Array(
            Type.Object({
                tag: Type.String(),
                status: Type.Number(),
                pricing: Type.Object({ overrides: Type.Optional(Type.Array(OverrideSchema)) }),
            }),
        ),
    }),
});

type Route = { model: string; tag: string; schedule: "deepseek-reseller" | "ali-deepseek" };
type Prices = { prompt: number; completion: number; input_cache_read: number };
type Override = { start: number; end: number; days: readonly string[]; prices: Prices };

const days = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];

const models = [
    "deepseek/deepseek-v4-pro-0813",
    "deepseek/deepseek-v4-flash-0731",
    "deepseek/deepseek-v4.1-flash-1017",
];

// Pi's private model objects are framework-shaped input; parse them here.
// oxlint-disable-next-line antislop/no-unknown-parameters -- The input is a private host model at the adapter boundary.
export function openRouterRoute(model: unknown): Route | undefined {
    if (!Value.Check(RoutingModel, model) || !models.includes(model.id)) return undefined;

    // Pi applies arbitrary sampling parameters after compat routing; reject
    // nonempty sets rather than guessing which request fields can affect routing.
    const parameterSets = [
        model.samplingParams,
        ...Object.values(model.samplingParamsByThinkingLevel ?? {}),
    ];
    if (parameterSets.some((params) => params !== undefined && Object.keys(params).length > 0))
        return undefined;

    const tag = model.compat.openRouterRouting.only[0];
    if (tag === "deepseek" && (model.id === models[0] || model.id === models[2]))
        return { model: model.id, tag, schedule: "deepseek-reseller" };

    if (tag === "alibaba" || tag === "alibaba/us-east-1")
        return { model: model.id, tag, schedule: "ali-deepseek" };

    return undefined;
}

function clock(value: number): number | undefined {
    const hours = Math.floor(value / 100);
    const minutes = value % 100;
    if (hours > 23 || hours < 0 || minutes > 59) return undefined;
    return hours * 60 + minutes;
}

function parseOverride(value: Static<typeof OverrideSchema>): Override | undefined {
    let start = 0;
    let end = 0;

    if (value.utc_start !== undefined) {
        const parsed = clock(value.utc_start);
        if (parsed === undefined) return undefined;

        start = parsed;
    }

    if (value.utc_end !== undefined) {
        const parsed = clock(value.utc_end);
        if (parsed === undefined) return undefined;

        end = parsed;
    }

    // Only midnight-terminated wrap and an all-day 00:00 interval have
    // unambiguous day semantics among the confirmed offers.
    if ((start > end && end !== 0) || (start === end && start !== 0)) return undefined;

    const selectedDays = value.utc_days ?? days;
    if (selectedDays.some((day) => !days.includes(day))) return undefined;

    const prices = {
        prompt: Number(value.prompt),
        completion: Number(value.completion),
        input_cache_read: Number(value.input_cache_read),
    };
    if (Object.values(prices).some((n) => !Number.isFinite(n) || n <= 0)) return undefined;

    return { start, end, days: selectedDays, prices };
}

// Every minute must have explicit input/output/cache prices; a base price may
// already reflect the instant at which OpenRouter supplied the response.
// oxlint-disable-next-line antislop/no-unknown-parameters -- Parse the external HTTP response at this adapter boundary.
export function openRouterSchedule(data: unknown, route: Route): Route["schedule"] | undefined {
    if (!Value.Check(ResponseSchema, data) || data.data.id !== route.model) return undefined;

    const matching = data.data.endpoints.filter(
        (item) => item.tag === route.tag || item.tag.startsWith(`${route.tag}/`),
    );
    if (
        matching.length !== 1 ||
        matching[0].tag !== route.tag ||
        matching[0].status !== 0 ||
        matching[0].pricing.overrides === undefined
    )
        return undefined;

    const overrides = matching[0].pricing.overrides.map(parseOverride);
    if (overrides.length === 0 || overrides.some((value) => value === undefined)) return undefined;

    let offMax: Prices = { prompt: 0, completion: 0, input_cache_read: 0 };
    let peakMin: Prices = { prompt: Infinity, completion: Infinity, input_cache_read: Infinity };
    for (let day = 0; day < 7; day += 1) {
        for (let minute = 0; minute < 1440; minute += 1) {
            let price: Prices | undefined;
            for (const override of overrides) {
                if (override === undefined || !override.days.includes(days[day])) continue;

                const matches =
                    override.start === override.end ||
                    (override.start < override.end &&
                        minute >= override.start &&
                        minute < override.end) ||
                    (override.start > override.end &&
                        (minute >= override.start || minute < override.end));
                if (matches) price = override.prices;
            }

            if (price === undefined) return undefined;

            let peak = minute < 840;
            if (route.schedule === "deepseek-reseller")
                peak =
                    day < 5 && ((minute >= 60 && minute < 240) || (minute >= 360 && minute < 600));

            if (peak) {
                peakMin = {
                    prompt: Math.min(peakMin.prompt, price.prompt),
                    completion: Math.min(peakMin.completion, price.completion),
                    input_cache_read: Math.min(peakMin.input_cache_read, price.input_cache_read),
                };
            } else {
                offMax = {
                    prompt: Math.max(offMax.prompt, price.prompt),
                    completion: Math.max(offMax.completion, price.completion),
                    input_cache_read: Math.max(offMax.input_cache_read, price.input_cache_read),
                };
            }
        }
    }

    if (
        offMax.prompt >= peakMin.prompt ||
        offMax.completion >= peakMin.completion ||
        offMax.input_cache_read >= peakMin.input_cache_read
    )
        return undefined;

    return route.schedule;
}

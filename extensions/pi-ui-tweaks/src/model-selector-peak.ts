import { ModelSelectorComponent } from "@earendil-works/pi-coding-agent";
import { visibleWidth } from "@earendil-works/pi-tui";
import {
    PHYSICAL_MODEL_ID,
    installLinkedMethodPatch,
    reportExtensionDiagnostic,
} from "@zigai/pi-extension-internals";
import { Type } from "typebox";
import { Value } from "typebox/value";
import { openRouterRoute, openRouterSchedule } from "./openrouter-peak.ts";
import { eligiblePeakRule } from "./peak-rule-eligibility.ts";
import { peakCountdown } from "./model-peak-schedule.ts";
import type { PeakHoliday, PeakRule } from "./settings-input.ts";

const PATCH = Symbol.for("zigai.pi-ui-tweaks.model-selector-peak");

type Config = {
    readonly offPeakRules: readonly PeakRule[];
    readonly deepseekHolidayCalendar: readonly PeakHoliday[];
};

type Handle = { update(config: Config): void; dispose(): void };

type Target = {
    filteredModels?: unknown;
    selectedIndex?: unknown;
    listContainer?: { children?: unknown };
    tui?: { requestRender(): void };
    closed?: boolean;
    updateList(): void;
    dispose(): void;
    [PATCH]?: Handle;
};

const targetMethodsSchema = Type.Object({
    updateList: Type.Function([], Type.Unknown()),
    dispose: Type.Function([], Type.Unknown()),
});

const selectionSchema = Type.Object({
    filteredModels: Type.Array(Type.Unknown()),
    selectedIndex: Type.Number(),
});

const selectedItemSchema = Type.Object({
    model: Type.Object({ provider: Type.String(), id: Type.String() }),
});

const renderableSchema = Type.Object({
    render: Type.Function([Type.Number()], Type.Unknown()),
});

const linesSchema = Type.Array(Type.String());

function hasMethods(value: unknown): value is Target {
    return Value.Check(targetMethodsSchema, value);
}

function selectedModel(target: Target): { provider: string; id: string; raw: unknown } | undefined {
    if (!Value.Check(selectionSchema, target)) return undefined;

    const item = target.filteredModels[target.selectedIndex];
    if (!Value.Check(selectedItemSchema, item)) return undefined;

    const model = item.model;
    let id = model.id;
    if (PHYSICAL_MODEL_ID in model) {
        const physicalId = model[PHYSICAL_MODEL_ID];
        if (Value.Check(Type.String(), physicalId)) id = physicalId;
    }

    return { provider: model.provider, id, raw: model };
}

function selectedRule(target: Target, config: Config): PeakRule | undefined {
    const model = selectedModel(target);
    if (model === undefined) return undefined;

    const rules = config.offPeakRules.filter(
        (rule) => rule.provider === model.provider && rule.model === model.id,
    );
    if (rules.length !== 1 || !eligiblePeakRule(rules[0])) return undefined;
    return rules[0];
}

function label(config: Config, schedule: Exclude<PeakRule["schedule"], "or">): string | undefined {
    return peakCountdown(schedule, new Date(), (date) => {
        const dates = config.deepseekHolidayCalendar.filter((entry) => entry.date === date);
        if (dates.length !== 1) return undefined;
        return dates[0]?.holiday;
    });
}

// oxlint-disable-next-line antislop/no-unknown-returns -- The fetch result is parsed by the OpenRouter boundary adapter.
async function fetchOpenRouterMetadata(url: string, signal: AbortSignal): Promise<unknown> {
    const response = await fetch(url, {
        signal: AbortSignal.any([signal, AbortSignal.timeout(5_000)]),
    });
    if (!response.ok) return undefined;
    return response.json();
}

/** Decorate only the selected physical model and own one timer per open picker. */
export function installModelSelectorPeakPatch(
    config: Config,
    getTheme: () => { fg(color: string, text: string): string } | undefined,
    // oxlint-disable-next-line antislop/no-object-parameters -- Unstable private host prototype.
    providedTarget?: object | null,
    fetchMetadata = fetchOpenRouterMetadata,
): Handle {
    // oxlint-disable-next-line antislop/no-object-parameters -- Unstable private host prototype.
    let target: object | null = ModelSelectorComponent.prototype;
    if (providedTarget !== undefined) target = providedTarget;

    if (!hasMethods(target)) {
        reportExtensionDiagnostic(
            "[pi-ui-tweaks] model picker peak patch unavailable; Pi internals may have changed",
        );

        return { update() {}, dispose() {} };
    }

    if (target[PATCH]) {
        target[PATCH].update(config);
        return target[PATCH];
    }

    let current = config;
    let disposed = false;
    const timers = new Map<Target, ReturnType<typeof setTimeout>>();
    const requests = new Map<
        Target,
        {
            key: string;
            controller: AbortController;
            expires: number;
            schedule?: "deepseek-reseller" | "ali-deepseek";
        }
    >();
    const clearRequest = (instance: Target): void => {
        requests.get(instance)?.controller.abort();
        requests.delete(instance);
    };

    const stop = (instance: Target): void => {
        const timer = timers.get(instance);
        if (timer !== undefined) clearTimeout(timer);
        timers.delete(instance);
    };

    const listPatch = installLinkedMethodPatch(
        target,
        "updateList",
        (predecessor) =>
            function (this: Target): void {
                predecessor.call(this);
                stop(this);

                if (
                    disposed ||
                    this.closed === true ||
                    this.listContainer === undefined ||
                    this.tui === undefined
                )
                    return;

                const rule = selectedRule(this, current);
                if (rule === undefined) {
                    clearRequest(this);
                    return;
                }

                let schedule: Exclude<PeakRule["schedule"], "or"> | undefined;
                if (rule.schedule === "or") {
                    const route = openRouterRoute(selectedModel(this)?.raw);
                    if (route !== undefined) {
                        const key = `${route.model}:${route.tag}`;
                        let request = requests.get(this);
                        if (request?.key !== key || request.expires <= Date.now()) {
                            clearRequest(this);

                            const controller = new AbortController();
                            request = { key, controller, expires: Date.now() + 60_000 };
                            requests.set(this, request);

                            const owned = request;
                            const url = `https://openrouter.ai/api/v1/models/${route.model}/endpoints`;

                            void fetchMetadata(url, controller.signal)
                                .then((body) => openRouterSchedule(body, route))
                                .catch(() => undefined)
                                .then((result) => {
                                    if (
                                        disposed ||
                                        this.closed === true ||
                                        requests.get(this) !== owned
                                    )
                                        return;

                                    owned.schedule = result;

                                    if (result !== undefined) {
                                        this.updateList();
                                        this.tui?.requestRender();
                                    }
                                });
                        }

                        schedule = request.schedule;
                    } else clearRequest(this);
                } else {
                    clearRequest(this);
                    schedule = rule.schedule;
                }

                let value: string | undefined;
                if (schedule !== undefined) value = label(current, schedule);

                const theme = getTheme();
                const models = this.filteredModels;
                const selected = this.selectedIndex;
                const children = this.listContainer.children;

                if (
                    value !== undefined &&
                    theme !== undefined &&
                    Array.isArray(models) &&
                    Value.Check(Type.Number(), selected) &&
                    selected >= 0 &&
                    selected < models.length &&
                    Array.isArray(children)
                ) {
                    const start = Math.max(0, Math.min(selected - 5, models.length - 10));
                    const child: unknown = children[selected - start];
                    if (Value.Check(renderableSchema, child)) {
                        const render = child.render;

                        child.render = function (width: number): string[] {
                            const result: unknown = render.call(this, width);
                            if (!Value.Check(linesSchema, result)) return [];

                            const lines: string[] = [...result];
                            const first = lines[0];
                            if (first === undefined || lines.length !== 1) return lines;

                            const row = first.trimEnd();
                            const suffix = `  ${value}`;
                            if (visibleWidth(row) + visibleWidth(suffix) > width) return lines;

                            let color = "muted";
                            if (value.startsWith("off-peak")) color = "success";
                            lines[0] = `${row}  ${theme.fg(color, value)}`;
                            return lines;
                        };
                    }
                }

                const delay = 60_000 - (Date.now() % 60_000);
                const timer = setTimeout(() => {
                    timers.delete(this);

                    if (disposed || this.closed === true) return;

                    this.updateList();
                    this.tui?.requestRender();
                }, delay);

                timer.unref();
                timers.set(this, timer);
            },
    );
    const disposePatch = installLinkedMethodPatch(
        target,
        "dispose",
        (predecessor) =>
            function (this: Target): void {
                stop(this);
                clearRequest(this);
                predecessor.call(this);
            },
    );
    const handle: Handle = {
        update(next) {
            if (!disposed) current = next;
        },
        dispose() {
            if (disposed) return;

            disposed = true;

            for (const instance of timers.keys()) stop(instance);

            for (const instance of requests.keys()) clearRequest(instance);
            disposePatch.dispose();
            listPatch.dispose();

            if (target[PATCH] === handle) delete target[PATCH];
        },
    };

    target[PATCH] = handle;
    return handle;
}

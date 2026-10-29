import * as sdk from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import { visibleWidth, type TuiMouseEvent, type TuiMouseEventResult } from "@earendil-works/pi-tui";
import { installLinkedMethodPatch } from "@zigai/pi-extension-internals";
import { Type, type StaticDecode } from "typebox";
import { Value } from "typebox/value";
import { formatTimestamp, type TimestampFormat } from "./format.ts";
import { isDivider, renderTimestamp, type TimestampHit } from "./render.ts";
import type { MessageTimestampsSettings } from "./settings.ts";

const componentSchema = Type.Object({
    render: Type.Function([Type.Number()], Type.Array(Type.String())),
    handleMouse: Type.Optional(Type.Function([Type.Unknown()], Type.Unknown())),
});

const hostSchema = Type.Object({
    sessionManager: Type.Object({ getSessionId: Type.Function([], Type.String()) }),
    chatContainer: Type.Object({ children: Type.Array(componentSchema) }),
    streamingComponent: Type.Optional(componentSchema),
    ui: Type.Object({ requestRender: Type.Function([], Type.Void()) }),
});

const prototypeSchema = Type.Object({
    addMessageToChat: Type.Function([Type.Unknown(), Type.Optional(Type.Unknown())], Type.Void()),
    handleEvent: Type.Function([Type.Unknown()], Type.Unknown()),
});
const moduleSchema = Type.Object({ InteractiveMode: Type.Function([], Type.Unknown()) });
const messageSchema = Type.Object({
    role: Type.Union([Type.Literal("user"), Type.Literal("assistant")]),
    timestamp: Type.Number(),
});

const assistantEventSchema = Type.Object({
    type: Type.Union([Type.Literal("message_start"), Type.Literal("message_end")]),
    message: Type.Object({ role: Type.Literal("assistant") }),
});

type Host = StaticDecode<typeof hostSchema>;
type Component = StaticDecode<typeof componentSchema>;
type Moment = number | string;

const markerKey = Symbol.for("zigai.pi-message-timestamps.host-patches");

export class Timestamps {
    private readonly patches: { dispose(): void }[] = [];
    private readonly rows = new WeakMap<Component, { timestamp: Moment | undefined }>();
    private readonly completions = new WeakMap<object, number>();
    private readonly history = new WeakMap<object, string>();
    private readonly prototype: StaticDecode<typeof prototypeSchema>;
    private host: Host | undefined;
    private timer: ReturnType<typeof setInterval> | undefined;
    private format: TimestampFormat;
    private disposed = false;
    private warned = false;

    constructor(
        private readonly ctx: ExtensionContext,
        settings: MessageTimestampsSettings,
    ) {
        this.format = settings.format;

        if (!Value.Check(moduleSchema, sdk)) throw new Error("Interactive host unavailable");

        const prototype: unknown = Object.getOwnPropertyDescriptor(
            sdk.InteractiveMode,
            "prototype",
        )?.value;
        if (!Value.Check(prototypeSchema, prototype))
            throw new Error("Interactive host methods unavailable");

        this.prototype = prototype;

        if (Object.getOwnPropertyDescriptor(prototype, markerKey) !== undefined)
            throw new Error("Message timestamps already active");

        try {
            for (const entry of ctx.sessionManager.getBranch())
                if (entry.type === "message") this.history.set(entry.message, entry.timestamp);

            const matchHost = this.matchHost.bind(this);
            const timestampFor = this.timestampFor.bind(this);
            const attach = this.attach.bind(this);
            const complete = this.complete.bind(this);
            const warnHost = this.warnHost.bind(this);

            this.patches.push(
                installLinkedMethodPatch(
                    prototype,
                    "addMessageToChat",
                    (previous) =>
                        function (message, options) {
                            let host: Host | undefined;
                            if (Value.Check(hostSchema, this)) host = matchHost(this);
                            else warnHost();

                            const count = host?.chatContainer.children.length;
                            previous.call(this, message, options);

                            if (
                                !host ||
                                count === undefined ||
                                !Value.Check(messageSchema, message)
                            )
                                return;

                            const added = host.chatContainer.children.slice(count);
                            const row = added.at(-1);
                            if (!row) return;

                            const timestamp = timestampFor(message);
                            if (timestamp !== undefined) attach(row, timestamp, message.role);
                        },
                ),
            );
            this.patches.push(
                installLinkedMethodPatch(
                    prototype,
                    "handleEvent",
                    (previous) =>
                        async function (event) {
                            let host: Host | undefined;
                            if (Value.Check(hostSchema, this)) host = matchHost(this);
                            else warnHost();

                            const streaming = host?.streamingComponent;

                            // Capture observation time before awaiting host event handling.
                            const completed = Date.now();

                            await previous.call(this, event);

                            if (
                                !host ||
                                !matchHost(host) ||
                                !Value.Check(assistantEventSchema, event)
                            )
                                return;

                            if (event.type === "message_start") {
                                const started = host.streamingComponent;
                                if (started) attach(started, undefined, "assistant");
                            } else if (streaming) {
                                complete(host, streaming, event.message, completed);
                            }
                        },
                ),
            );

            // Publish the owner only after the required host methods are validated and patched.
            Object.defineProperty(prototype, markerKey, { configurable: true, value: this });

            this.updateTimer();
        } catch (cause) {
            this.dispose();
            throw cause;
        }
    }

    private warnHost(): void {
        if (this.warned || this.disposed) return;

        this.warned = true;
        this.ctx.ui.notify(
            "Message timestamps: unsupported interactive host shape; timestamps may be unavailable.",
            "warning",
        );
    }

    private matchHost(value: Host): Host | undefined {
        if (this.disposed) return undefined;

        if (value.sessionManager.getSessionId() !== this.ctx.sessionManager.getSessionId())
            return undefined;

        this.host = value;
        return value;
    }

    private complete(
        host: Host,
        streaming: Component,
        message: StaticDecode<typeof assistantEventSchema>["message"],
        completed: number,
    ): void {
        if (this.disposed || !this.matchHost(host)) return;

        this.completions.set(message, completed);
        this.attach(streaming, completed, "assistant");
        host.ui.requestRender();
    }

    private timestampFor(message: {
        role: "user" | "assistant";
        timestamp: number;
    }): Moment | undefined {
        if (message.role === "user") return message.timestamp;

        const observed = this.completions.get(message);
        if (observed !== undefined) return observed;

        // The session entry is persisted after completion; message.timestamp is start time.
        const known = this.history.get(message);
        if (known !== undefined) return known;

        // Tree navigation can expose entries outside the branch captured at startup.
        for (const entry of this.ctx.sessionManager.getBranch()) {
            if (entry.type === "message") this.history.set(entry.message, entry.timestamp);
        }

        return this.history.get(message);
    }

    private updateTimer(): void {
        if (this.format !== "relative") {
            if (this.timer !== undefined) clearInterval(this.timer);
            this.timer = undefined;
            return;
        }

        if (this.timer !== undefined) return;

        this.timer = setInterval(() => {
            if (!this.disposed) this.host?.ui.requestRender();
        }, 60_000);
        this.timer.unref();
    }

    private cycle(): void {
        const formats: TimestampFormat[] = ["auto", "time-only", "date-time", "relative"];
        this.format = formats[(formats.indexOf(this.format) + 1) % formats.length];
        this.updateTimer();
        this.host?.ui.requestRender();
    }

    private attach(
        component: Component,
        timestamp: Moment | undefined,
        role: "user" | "assistant",
    ): void {
        const existing = this.rows.get(component);
        if (existing !== undefined) {
            existing.timestamp = timestamp;
            return;
        }

        const row = { timestamp };
        let hit: TimestampHit | undefined;
        let assistantLayout: { width: number; contentWidth: number } | undefined;
        const currentFormat = () => this.format;
        const isDisposed = () => this.disposed;
        const cycle = () => this.cycle();
        const background = (padding: string) => this.ctx.ui.theme.bg("userMessageBg", padding);

        // The proxy supplies an absent predecessor without modifying the component first.
        // Linked disposal therefore restores a genuinely absent method, even under successors.
        const mouseTarget = new Proxy(
            {
                handleMouse(
                    this: Component,
                    _event: TuiMouseEvent,
                ): TuiMouseEventResult | undefined {
                    return undefined;
                },
            },
            {
                get(target, key) {
                    if (key !== "handleMouse") return undefined;
                    // Preserve the receiver for existing component handlers.
                    // oxlint-disable-next-line typescript/unbound-method -- The linked patch calls the predecessor with the original component receiver.
                    return component.handleMouse ?? target.handleMouse;
                },
                set(_target, key, value) {
                    return Reflect.set(component, key, value);
                },
                getOwnPropertyDescriptor(_target, key) {
                    return Reflect.getOwnPropertyDescriptor(component, key);
                },
                defineProperty(_target, key, descriptor) {
                    return Reflect.defineProperty(component, key, descriptor);
                },
                deleteProperty(_target, key) {
                    return Reflect.deleteProperty(component, key);
                },
            },
        );

        try {
            const renderPatch = installLinkedMethodPatch(
                component,
                "render",
                (previous) =>
                    function (width) {
                        if (isDisposed()) return previous.call(this, width);

                        // A pending row reserves the same gutter as its completion label.
                        // Never lay out already-visible thinking at a new width just to
                        // attach a timestamp when message_end arrives.
                        const label = formatTimestamp(row.timestamp ?? Date.now(), currentFormat());
                        const contentWidth = width - visibleWidth(label) - 2;
                        let layoutWidth = width;

                        if (role === "assistant") {
                            if (contentWidth > 0) layoutWidth = contentWidth;
                            assistantLayout = { width, contentWidth: layoutWidth };
                        }

                        let lines = previous.call(this, layoutWidth);
                        if (layoutWidth < width) {
                            lines = lines.map((line) => {
                                if (!isDivider(line, layoutWidth)) return line;

                                return line.replace(
                                    /─{2,}/u,
                                    (divider) => divider + "─".repeat(width - layoutWidth),
                                );
                            });
                        }

                        if (row.timestamp === undefined) {
                            hit = undefined;
                            return lines;
                        }

                        let rendered = renderTimestamp(lines, width, label);
                        if (role === "user" && !rendered.hit && contentWidth > 0) {
                            let wrapped = previous.call(this, contentWidth);

                            wrapped = wrapped.map((line, index) => {
                                const original = lines.at(index);
                                if (
                                    original !== undefined &&
                                    isDivider(original, width) &&
                                    isDivider(line, contentWidth)
                                )
                                    return original;

                                return line;
                            });
                            wrapped = wrapped.map((line) => {
                                const padding = Math.max(0, width - visibleWidth(line));
                                return line + background(" ".repeat(padding));
                            });

                            rendered = renderTimestamp(wrapped, width, label);
                            if (!rendered.hit) rendered = { lines: previous.call(this, width) };
                        }

                        hit = rendered.hit;
                        return rendered.lines;
                    },
            );
            let mousePatch: { dispose(): void };
            try {
                mousePatch = installLinkedMethodPatch(
                    mouseTarget,
                    "handleMouse",
                    (previous) =>
                        function (event) {
                            if (
                                !isDisposed() &&
                                hit &&
                                event.width === hit.renderWidth &&
                                event.y === hit.y &&
                                event.x >= hit.x &&
                                event.x < hit.x + hit.width &&
                                event.button === "left" &&
                                (event.type === "press" || event.type === "click")
                            ) {
                                if (event.type === "click") cycle();
                                return { handled: true };
                            }

                            if (!isDisposed() && assistantLayout?.width === event.width) {
                                return previous.call(component, {
                                    ...event,
                                    width: assistantLayout.contentWidth,
                                });
                            }

                            return previous.call(component, event);
                        },
                );
            } catch (cause) {
                renderPatch.dispose();
                throw cause;
            }

            this.patches.push(renderPatch, mousePatch);
            this.rows.set(component, row);
        } catch {
            if (!this.warned) {
                this.warned = true;
                this.ctx.ui.notify(
                    "Message timestamps: unable to patch a message component.",
                    "warning",
                );
            }
        }
    }

    dispose(): void {
        if (this.disposed) return;

        this.disposed = true;
        if (this.timer !== undefined) clearInterval(this.timer);

        for (const patch of this.patches.reverse()) patch.dispose();
        this.patches.length = 0;
        if (Object.getOwnPropertyDescriptor(this.prototype, markerKey)?.value === this)
            Reflect.deleteProperty(this.prototype, markerKey);

        this.host = undefined;
    }
}

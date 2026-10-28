import * as sdk from "@earendil-works/pi-coding-agent";
import type { ExtensionContext } from "@earendil-works/pi-coding-agent";
import type { TuiMouseEvent, TuiMouseEventResult } from "@earendil-works/pi-tui";
import { installLinkedMethodPatch } from "@zigai/pi-extension-internals";
import { Type, type StaticDecode } from "typebox";
import { Value } from "typebox/value";
import { formatTimestamp, type TimestampFormat } from "./format.ts";
import { renderTimestamp, type TimestampHit } from "./render.ts";
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

const endSchema = Type.Object({
    type: Type.Literal("message_end"),
    message: Type.Object({ role: Type.Literal("assistant") }),
});

type Host = StaticDecode<typeof hostSchema>;
type Component = StaticDecode<typeof componentSchema>;
type Moment = number | string;

const markerKey = Symbol.for("zigai.pi-message-timestamps.host-patches");

export class Timestamps {
    private readonly patches: { dispose(): void }[] = [];
    private readonly rows = new WeakSet();
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
                            if (timestamp !== undefined) attach(row, timestamp);
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

                            if (!host || !streaming || !Value.Check(endSchema, event)) return;

                            complete(host, streaming, event.message, completed);
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
        message: StaticDecode<typeof endSchema>["message"],
        completed: number,
    ): void {
        if (this.disposed || !this.matchHost(host)) return;

        this.completions.set(message, completed);
        this.attach(streaming, completed);
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

    private attach(component: Component, timestamp: Moment): void {
        if (this.rows.has(component)) return;

        let hit: TimestampHit | undefined;
        const currentFormat = () => this.format;
        const isDisposed = () => this.disposed;
        const cycle = () => this.cycle();

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
                        const lines = previous.call(this, width);
                        if (isDisposed()) return lines;

                        const rendered = renderTimestamp(
                            lines,
                            width,
                            formatTimestamp(timestamp, currentFormat()),
                        );
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

                            return previous.call(component, event);
                        },
                );
            } catch (cause) {
                renderPatch.dispose();
                throw cause;
            }

            this.patches.push(renderPatch, mousePatch);
            this.rows.add(component);
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

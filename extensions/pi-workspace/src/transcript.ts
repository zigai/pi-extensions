import {
    HStack,
    Text,
    VStack,
    type Component,
    type TuiMouseEvent,
    type TuiMouseEventResult,
} from "@earendil-works/pi-tui";
import { prepareTranscriptPresentation } from "@zigai/pi-extension-internals";
import { BackendRegistry } from "./backend-registry.ts";

export type TranscriptMetadata = {
    readonly id?: string;
    readonly role?: string;
    readonly timestamp?: string;
    readonly durationMs?: number;
    readonly timeoutSeconds?: number;
};

export type TranscriptSource = {
    readonly native: Component & { readonly children: readonly Component[] };
    metadata(component: Component): TranscriptMetadata;
    openEntry(id: string): void;

    readonly metadataFields: {
        readonly timestamp: boolean;
        readonly duration: boolean;
        readonly timeout: boolean;
    };
};

export type TranscriptView = {
    readonly component: Component;
    refresh(): void;

    rows(width: number): readonly {
        readonly component: Component;
        readonly metadata: TranscriptMetadata;
        readonly height: number;
    }[];

    dispose(): void;
};

export type TranscriptBackend = { create(source: TranscriptSource): TranscriptView };

class MetadataBadge extends Text {
    constructor(
        private readonly source: TranscriptSource,
        private readonly owner: Component,
    ) {
        super("", 0, 0);
    }

    override render(width: number): string[] {
        const metadata = this.source.metadata(this.owner);
        const fields: string[] = [];
        if (metadata.role !== undefined) fields.push(metadata.role);
        if (metadata.id !== undefined) fields.push(metadata.id);
        if (this.source.metadataFields.timestamp && metadata.timestamp !== undefined)
            fields.push(metadata.timestamp);

        if (this.source.metadataFields.duration && metadata.durationMs !== undefined)
            fields.push(`${Math.round(metadata.durationMs)} ms`);

        if (this.source.metadataFields.timeout && metadata.timeoutSeconds !== undefined)
            fields.push(`Timeout ${metadata.timeoutSeconds} s`);

        this.setText(fields.join("\n"));

        return super.render(width);
    }

    handleMouse(event: TuiMouseEvent): TuiMouseEventResult | undefined {
        const id = this.source.metadata(this.owner).id;
        if (event.type !== "click" || event.button !== "left" || id === undefined) return undefined;

        this.source.openEntry(id);

        return { handled: true };
    }
}

class LedgerTranscript extends VStack implements TranscriptView {
    readonly component: Component = this;
    private readonly cards = new WeakMap<Component, Component>();

    constructor(private readonly source: TranscriptSource) {
        super();
        this.refresh();
    }

    refresh(): void {
        this.clear();

        for (const component of this.source.native.children) {
            let card = this.cards.get(component);
            if (card === undefined) {
                card = new VStack([
                    {
                        component: new MetadataBadge(this.source, component),
                        visible: (viewport) =>
                            viewport.width < 64 &&
                            Object.keys(this.source.metadata(component)).length > 0,
                    },
                    {
                        component: new HStack(
                            [
                                {
                                    component: new MetadataBadge(this.source, component),
                                    basis: 24,
                                    shrink: 0,
                                    visible: (viewport) =>
                                        viewport.width >= 64 &&
                                        Object.keys(this.source.metadata(component)).length > 0,
                                },
                                { component, grow: 1, minSize: 1 },
                            ],
                            { gap: 2, align: "start" },
                        ),
                    },
                ]);
                this.cards.set(component, card);
            }

            this.addChild(card);
        }
    }

    override render(width: number): string[] {
        prepareTranscriptPresentation(this.source.native);
        return super.render(width);
    }

    rows(
        width: number,
    ): readonly { component: Component; metadata: TranscriptMetadata; height: number }[] {
        prepareTranscriptPresentation(this.source.native);

        return this.source.native.children.map((component) => ({
            component,
            metadata: this.source.metadata(component),
            height: this.cards.get(component)?.render(width).length ?? 0,
        }));
    }

    dispose(): void {
        this.clear();
    }
}

const registryKey = Symbol.for("zigai.pi-workspace.transcript-backends");

type Shared = typeof globalThis & { [registryKey]?: BackendRegistry<TranscriptBackend> };

const shared: Shared = globalThis;

const builtins: ReadonlyMap<string, TranscriptBackend> = new Map([
    [
        "native",
        {
            create: (source) => ({
                component: source.native,
                refresh(): void {},
                rows: (width) => {
                    prepareTranscriptPresentation(source.native);

                    return source.native.children.map((component) => ({
                        component,
                        metadata: source.metadata(component),
                        height: component.render(width).length,
                    }));
                },
                dispose(): void {},
            }),
        },
    ],
    ["ledger", { create: (source) => new LedgerTranscript(source) }],
]);

export const transcriptBackends = shared[registryKey] ?? new BackendRegistry(builtins, "native");
shared[registryKey] = transcriptBackends;

export function registerTranscriptBackend(
    name: string,
    backend: TranscriptBackend,
): { update(next: TranscriptBackend): void; dispose(): void } {
    return transcriptBackends.register(name, backend);
}

export function selectTranscriptBackend(name: string): void {
    transcriptBackends.select(name);
}

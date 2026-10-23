import { describe, expect, test } from "vitest";

import {
    registerEditorBackend,
    registerEditorEnhancer,
    type EditorEnhancerHandle,
    type EditorFactory,
} from "@zigai/pi-extension-internals";

type FactoryArgs = [label: string, count: number];
type Editor = string[];

function enhancerKey(name: string): symbol {
    return Symbol.for(`zigai.pi-extension-internals.test.${name}`);
}

const EDITOR_ENHANCER_REGISTRY = Symbol.for("zigai.pi-tweaks.editor-enhancer-registry");
const EDITOR_ENHANCER_PROTOCOL = Symbol.for("zigai.pi-tweaks.editor-enhancer-protocol-version");

type InstalledRegistryView = {
    [EDITOR_ENHANCER_PROTOCOL]?: unknown;
    enhancers: Map<unknown, unknown>;
};

function isInstalledRegistry(value: unknown): value is InstalledRegistryView {
    return (
        typeof value === "object" &&
        value !== null &&
        "enhancers" in value &&
        value.enhancers instanceof Map
    );
}

/** Reads and validates the portion of the installed protocol exercised by these tests. */
function installedRegistry(ui: EditorUi): InstalledRegistryView {
    const registry: unknown = Object.getOwnPropertyDescriptor(ui, EDITOR_ENHANCER_REGISTRY)?.value;
    if (!isInstalledRegistry(registry)) {
        throw new TypeError("Expected an installed editor enhancer registry");
    }

    return registry;
}

class EditorUi {
    private factory: EditorFactory<FactoryArgs, Editor> | undefined;

    constructor(factory?: EditorFactory<FactoryArgs, Editor>) {
        this.factory = factory;
    }

    getEditorComponent(): EditorFactory<FactoryArgs, Editor> | undefined {
        return this.factory;
    }

    setEditorComponent(factory: EditorFactory<FactoryArgs, Editor> | undefined): void {
        this.factory = factory;
    }
}

class FailingEditorUi extends EditorUi {
    private failSet = false;

    failNextSet(): void {
        this.failSet = true;
    }

    override setEditorComponent(factory: EditorFactory<FactoryArgs, Editor> | undefined): void {
        if (this.failSet) {
            this.failSet = false;
            throw new Error("set editor failed");
        }

        super.setEditorComponent(factory);
    }
}

function renderEditor(ui: EditorUi): Editor {
    const factory = ui.getEditorComponent();
    if (factory === undefined) {
        throw new Error("Expected an installed editor factory");
    }

    return factory("prompt", 3);
}

describe("registerEditorBackend", () => {
    test("restores the original after retiring a deep predecessor chain in reverse order", () => {
        const original: EditorFactory<FactoryArgs, Editor> = () => ["original"];
        const ui = new EditorUi(original);
        const ctx = { hasUI: true, ui };
        const predecessors = Array.from({ length: 20_000 }, (_, index) =>
            registerEditorBackend(ctx, () => [`backend-${index}`]),
        );
        const top = registerEditorBackend(ctx, () => ["top"]);

        for (const predecessor of predecessors.reverse()) predecessor.dispose();
        expect(renderEditor(ui)).toEqual(["top"]);

        expect(() => top.dispose()).not.toThrow();
        expect(ui.getEditorComponent()).toBe(original);
        expect(renderEditor(ui)).toEqual(["original"]);
    });

    test("prunes a retired predecessor from every externally restored successor branch", () => {
        const original: EditorFactory<FactoryArgs, Editor> = () => ["original"];
        const ui = new EditorUi(original);
        const ctx = { hasUI: true, ui };
        const first = registerEditorBackend(ctx, () => ["backend-a"]);
        const firstFactory = ui.getEditorComponent();
        const second = registerEditorBackend(ctx, () => ["backend-b"]);
        const secondFactory = ui.getEditorComponent();
        ui.setEditorComponent(firstFactory);
        const third = registerEditorBackend(ctx, () => ["backend-c"]);

        first.dispose();
        expect(renderEditor(ui)).toEqual(["backend-c"]);
        third.dispose();
        expect(ui.getEditorComponent()).toBe(original);

        ui.setEditorComponent(secondFactory);
        second.dispose();
        expect(ui.getEditorComponent()).toBe(original);
    });

    test("keeps distinct ownership when two registrations use the same factory", () => {
        const original: EditorFactory<FactoryArgs, Editor> = () => ["original"];
        const shared: EditorFactory<FactoryArgs, Editor> = () => ["shared"];
        const ui = new EditorUi(original);
        const ctx = { hasUI: true, ui };
        const first = registerEditorBackend(ctx, shared);
        const second = registerEditorBackend(ctx, shared);

        first.dispose();
        first.dispose();
        first.update(() => ["disposed"]);
        expect(renderEditor(ui)).toEqual(["shared"]);

        second.update((label, count) => [`updated:${label}:${count}`]);
        expect(renderEditor(ui)).toEqual(["updated:prompt:3"]);
        second.dispose();
        second.dispose();
        expect(ui.getEditorComponent()).toBe(original);
    });

    test("does not reclaim an external editor on backend update or disposal", () => {
        const original: EditorFactory<FactoryArgs, Editor> = () => ["original"];
        const external: EditorFactory<FactoryArgs, Editor> = () => ["external"];
        const ui = new EditorUi(original);
        const ctx = { hasUI: true, ui };
        const first = registerEditorBackend(ctx, () => ["backend-a"]);
        const second = registerEditorBackend(ctx, () => ["backend-b"]);
        ui.setEditorComponent(external);

        first.update(() => ["updated-a"]);
        second.update(() => ["updated-b"]);
        first.dispose();
        second.dispose();

        expect(ui.getEditorComponent()).toBe(external);
    });

    test("rolls back failed backend setters under an enhancer and allows retry", () => {
        class SynchronousFailingUi extends FailingEditorUi {
            active: Editor = [];

            override setEditorComponent(
                factory: EditorFactory<FactoryArgs, Editor> | undefined,
            ): void {
                super.setEditorComponent(factory);
                this.active = factory?.("prompt", 3) ?? [];
            }
        }

        const original: EditorFactory<FactoryArgs, Editor> = () => ["original"];
        const ui = new SynchronousFailingUi(original);
        const ctx = { hasUI: true, ui };
        const enhancer = registerEditorEnhancer(
            ctx,
            enhancerKey("backend-failed-setters"),
            () => ["fallback"],
            (editor) => [...editor, "enhanced"],
        );
        const backend = registerEditorBackend(ctx, () => ["backend-a"]);
        try {
            ui.failNextSet();
            expect(() => registerEditorBackend(ctx, () => ["failed-registration"])).toThrow(
                "set editor failed",
            );

            expect(renderEditor(ui)).toEqual(["backend-a", "enhanced"]);

            ui.failNextSet();
            expect(() => backend.update(() => ["backend-b"])).toThrow("set editor failed");
            expect(renderEditor(ui)).toEqual(["backend-a", "enhanced"]);

            backend.update(() => ["backend-b"]);
            expect(ui.active).toEqual(["backend-b", "enhanced"]);
            expect(renderEditor(ui)).toEqual(["backend-b", "enhanced"]);
            ui.failNextSet();
            expect(() => backend.dispose()).toThrow("set editor failed");
            expect(renderEditor(ui)).toEqual(["backend-b", "enhanced"]);

            backend.dispose();
            expect(renderEditor(ui)).toEqual(["original", "enhanced"]);
            enhancer.dispose();
            expect(ui.getEditorComponent()).toBe(original);
        } finally {
            backend.dispose();
            enhancer.dispose();
        }
    });

    test.each([
        { scenario: "without an editor enhancer", enhanced: false, suffix: [] },
        { scenario: "with an editor enhancer", enhanced: true, suffix: ["enhanced"] },
    ])(
        "restores the original after disposing a superseded backend before its successor $scenario",
        ({ enhanced, suffix }) => {
            const original: EditorFactory<FactoryArgs, Editor> = () => ["original"];
            const backendA: EditorFactory<FactoryArgs, Editor> = () => ["backend-a"];
            const backendB: EditorFactory<FactoryArgs, Editor> = () => ["backend-b"];
            const ui = new EditorUi(original);
            const ctx = { hasUI: true, ui };
            let enhancer: EditorEnhancerHandle<FactoryArgs, Editor> | undefined;
            if (enhanced) {
                enhancer = registerEditorEnhancer(
                    ctx,
                    enhancerKey("backend-out-of-order-disposal"),
                    () => ["fallback"],
                    (editor) => [...editor, "enhanced"],
                );
            }

            const first = registerEditorBackend(ctx, backendA);
            const second = registerEditorBackend(ctx, backendB);
            try {
                expect(renderEditor(ui)).toEqual(["backend-b", ...suffix]);

                first.dispose();
                expect(renderEditor(ui)).toEqual(["backend-b", ...suffix]);

                second.dispose();
                expect(renderEditor(ui)).toEqual(["original", ...suffix]);

                enhancer?.dispose();
                expect(ui.getEditorComponent()).toBe(original);
            } finally {
                first.dispose();
                second.dispose();
                enhancer?.dispose();
            }
        },
    );
});

describe("registerEditorEnhancer", () => {
    test("updates the live editor when Pi constructs factories synchronously", () => {
        class SynchronousUi extends EditorUi {
            active: Editor = [];

            override setEditorComponent(
                factory: EditorFactory<FactoryArgs, Editor> | undefined,
            ): void {
                super.setEditorComponent(factory);
                this.active = factory?.("prompt", 3) ?? [];
            }
        }

        const ui = new SynchronousUi();
        const ctx = { hasUI: true, ui };
        const first = registerEditorEnhancer(
            ctx,
            enhancerKey("synchronous-first"),
            () => ["base"],
            (editor) => [...editor, "first"],
        );
        expect(ui.active).toEqual(["base", "first"]);
        const second = registerEditorEnhancer(
            ctx,
            enhancerKey("synchronous-second"),
            () => ["unused"],
            (editor) => [...editor, "second"],
        );
        expect(ui.active).toEqual(["base", "first", "second"]);
        first.update((editor) => [...editor, "updated"]);
        expect(ui.active).toEqual(["base", "updated", "second"]);
        first.dispose();
        expect(ui.active).toEqual(["base", "second"]);
        second.dispose();
        expect(ui.active).toEqual([]);
    });

    test("replaces keyed enhancers without reordering and forwards factory arguments", () => {
        const ui = new EditorUi();
        const ctx = { hasUI: true, ui };
        const createDefault: EditorFactory<FactoryArgs, Editor> = (label, count) => [
            `default:${label}:${count}`,
        ];

        const first = registerEditorEnhancer(
            ctx,
            enhancerKey("replacement-first"),
            createDefault,
            (editor, label, count) => [...editor, `first:${label}:${count}`],
        );
        registerEditorEnhancer(ctx, enhancerKey("replacement-second"), createDefault, (editor) => [
            ...editor,
            "second",
        ]);
        const replacement = registerEditorEnhancer(
            ctx,
            enhancerKey("replacement-first"),
            createDefault,
            (editor) => [...editor, "replacement"],
        );
        first.dispose();
        replacement.update((editor) => [...editor, "updated"]);

        expect(renderEditor(ui)).toEqual(["default:prompt:3", "updated", "second"]);
    });

    test("rebases over arbitrary factories and restores the base after idempotent disposal", () => {
        const originalBase: EditorFactory<FactoryArgs, Editor> = () => ["original"];
        const rebasedFactory: EditorFactory<FactoryArgs, Editor> = () => ["rebased"];
        const createDefault: EditorFactory<FactoryArgs, Editor> = () => ["default"];
        const ui = new EditorUi(originalBase);
        const ctx = { hasUI: true, ui };
        const first = registerEditorEnhancer(
            ctx,
            enhancerKey("rebase-first"),
            createDefault,
            (editor) => [...editor, "first"],
        );

        ui.setEditorComponent(rebasedFactory);
        const second = registerEditorEnhancer(
            ctx,
            enhancerKey("rebase-second"),
            createDefault,
            (editor) => [...editor, "second"],
        );
        expect(renderEditor(ui)).toEqual(["rebased", "first", "second"]);

        first.dispose();
        expect(renderEditor(ui)).toEqual(["rebased", "second"]);
        second.dispose();
        second.dispose();

        expect(ui.getEditorComponent()).toBe(rebasedFactory);
    });

    test("failed live removal preserves enhancer ordering and can be retried", () => {
        const ui = new FailingEditorUi();
        const ctx = { hasUI: true, ui };
        const first = registerEditorEnhancer(
            ctx,
            enhancerKey("remove-first"),
            () => ["base"],
            (editor) => [...editor, "first"],
        );
        const second = registerEditorEnhancer(
            ctx,
            enhancerKey("remove-second"),
            () => ["unused"],
            (editor) => [...editor, "second"],
        );
        ui.failNextSet();
        expect(() => first.dispose()).toThrow("set editor failed");
        expect(renderEditor(ui)).toEqual(["base", "first", "second"]);
        first.dispose();
        expect(renderEditor(ui)).toEqual(["base", "second"]);
        second.dispose();
    });

    test("removal does not reclaim an editor installed by another owner", () => {
        const ui = new EditorUi();
        const ctx = { hasUI: true, ui };
        const first = registerEditorEnhancer(
            ctx,
            enhancerKey("external-first"),
            () => ["base"],
            (editor) => [...editor, "first"],
        );
        const second = registerEditorEnhancer(
            ctx,
            enhancerKey("external-second"),
            () => ["unused"],
            (editor) => [...editor, "second"],
        );
        const external: EditorFactory<FactoryArgs, Editor> = () => ["outside"];
        ui.setEditorComponent(external);
        first.dispose();
        expect(ui.getEditorComponent()).toBe(external);
        second.dispose();
        expect(ui.getEditorComponent()).toBe(external);
    });

    test("returns an inert handle when no UI is available", () => {
        const ui = new EditorUi();
        const handle = registerEditorEnhancer(
            { hasUI: false, ui },
            enhancerKey("headless"),
            () => ["default"],
            (editor) => [...editor, "unused"],
        );

        handle.update((editor) => [...editor, "still-unused"]);
        handle.dispose();
        expect(ui.getEditorComponent()).toBeUndefined();
    });

    test("keeps the first fallback factory when later extensions register", () => {
        const ui = new EditorUi();
        const ctx = { hasUI: true, ui };
        const first = registerEditorEnhancer(
            ctx,
            enhancerKey("fallback-first"),
            () => ["first-default"],
            (editor) => [...editor, "first"],
        );
        const second = registerEditorEnhancer(
            ctx,
            enhancerKey("fallback-second"),
            () => ["second-default"],
            (editor) => [...editor, "second"],
        );

        expect(renderEditor(ui)).toEqual(["first-default", "first", "second"]);
        second.dispose();
        first.dispose();
    });

    test("requires reload-stable globally registered keys", () => {
        const ui = new EditorUi();
        expect(() =>
            registerEditorEnhancer(
                { hasUI: true, ui },
                Symbol("local"),
                () => ["default"],
                (editor) => editor,
            ),
        ).toThrow("Symbol.for");
    });

    test("adopts a structurally valid legacy registry as protocol v1", () => {
        const ui = new EditorUi();
        const ctx = { hasUI: true, ui };
        const first = registerEditorEnhancer(
            ctx,
            enhancerKey("legacy-first"),
            () => ["default"],
            (editor) => [...editor, "first"],
        );
        const registry = installedRegistry(ui);
        Reflect.deleteProperty(registry, EDITOR_ENHANCER_PROTOCOL);

        const second = registerEditorEnhancer(
            ctx,
            enhancerKey("legacy-second"),
            () => ["ignored"],
            (editor) => [...editor, "second"],
        );

        expect(registry[EDITOR_ENHANCER_PROTOCOL]).toBe(1);
        expect(renderEditor(ui)).toEqual(["default", "first", "second"]);
        second.dispose();
        first.dispose();
    });

    test("rejects an incompatible shared registry version", () => {
        const ui = new EditorUi();
        Reflect.set(ui, EDITOR_ENHANCER_REGISTRY, {
            [EDITOR_ENHANCER_PROTOCOL]: 2,
        });

        expect(() =>
            registerEditorEnhancer(
                { hasUI: true, ui },
                enhancerKey("incompatible"),
                () => ["default"],
                (editor) => editor,
            ),
        ).toThrow("Unsupported editor enhancer protocol version 2");
    });

    test("rejects malformed enhancer entries in a shared registry", () => {
        const ui = new EditorUi();
        const ctx = { hasUI: true, ui };
        const first = registerEditorEnhancer(
            ctx,
            enhancerKey("malformed-first"),
            () => ["default"],
            (editor) => [...editor, "first"],
        );
        const registry = installedRegistry(ui);
        const enhancerMap = registry.enhancers;
        const malformedKey = enhancerKey("malformed-entry");
        enhancerMap.set(malformedKey, { enhancer: "not callable" });

        try {
            expect(() =>
                registerEditorEnhancer(
                    ctx,
                    enhancerKey("malformed-second"),
                    () => ["ignored"],
                    (editor) => editor,
                ),
            ).toThrow("Incompatible editor enhancer registry");
        } finally {
            enhancerMap.delete(malformedKey);
            first.dispose();
        }
    });

    test("does not partially install a registry on a non-extensible UI", () => {
        const ui = Object.preventExtensions(new EditorUi());

        expect(() =>
            registerEditorEnhancer(
                { hasUI: true, ui },
                enhancerKey("non-extensible-ui"),
                () => ["default"],
                (editor) => editor,
            ),
        ).toThrow("Unable to store the editor enhancer registry");

        expect(ui.getEditorComponent()).toBeUndefined();
    });

    test("rolls back a new registry when editor activation fails", () => {
        const ui = new FailingEditorUi();
        ui.failNextSet();

        expect(() =>
            registerEditorEnhancer(
                { hasUI: true, ui },
                enhancerKey("failed-activation"),
                () => ["default"],
                (editor) => [...editor, "unreachable"],
            ),
        ).toThrow("set editor failed");

        expect(Object.hasOwn(ui, EDITOR_ENHANCER_REGISTRY)).toBe(false);
        expect(ui.getEditorComponent()).toBeUndefined();

        const recovered = registerEditorEnhancer(
            { hasUI: true, ui },
            enhancerKey("recovered-activation"),
            () => ["default"],
            (editor) => [...editor, "recovered"],
        );
        expect(renderEditor(ui)).toEqual(["default", "recovered"]);
        recovered.dispose();
    });

    test("allows disposal to be retried after restoring the editor fails", () => {
        const ui = new FailingEditorUi();
        const handle = registerEditorEnhancer(
            { hasUI: true, ui },
            enhancerKey("retry-disposal"),
            () => ["default"],
            (editor) => [...editor, "enhanced"],
        );
        ui.failNextSet();

        expect(() => handle.dispose()).toThrow("set editor failed");
        expect(Object.hasOwn(ui, EDITOR_ENHANCER_REGISTRY)).toBe(true);
        expect(renderEditor(ui)).toEqual(["default", "enhanced"]);

        handle.dispose();
        expect(Object.hasOwn(ui, EDITOR_ENHANCER_REGISTRY)).toBe(false);
        expect(ui.getEditorComponent()).toBeUndefined();
    });
});

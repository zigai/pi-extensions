import assert from "node:assert/strict";
import { test } from "vitest";

import { installModelSelectorHintPatch } from "../src/model-selector-hint.ts";

const HINT = "Only showing models from configured providers. Use /login to add providers.";

type Component = { render(width: number): string[]; invalidate(): void };

class Text implements Component {
    constructor(readonly text: string) {}

    render(): string[] {
        return [];
    }

    invalidate(): void {}
}

class Spacer implements Component {
    readonly lines = 1;

    render(): string[] {
        return [];
    }

    invalidate(): void {}
}

function selector() {
    const addedComponents = new Array<Component>();

    return {
        addedComponents,
        addChild: (component: Component): void => {
            addedComponents.push(component);
        },
    };
}

test("model selector hint and its immediate spacer are removed", () => {
    const target = selector();
    const before = new Text("before");
    const after = new Text("after");
    installModelSelectorHintPatch(
        { compactModelSelector: false, hideModelProviderHint: true },
        target,
    );

    target.addChild(before);
    target.addChild(new Text(HINT));
    target.addChild(new Spacer());
    target.addChild(after);
    assert.deepEqual(target.addedComponents, [before, after]);
});

test("compact model selector independently removes spacer rows and updates idempotently", () => {
    const target = selector();
    const handle = installModelSelectorHintPatch(
        { compactModelSelector: true, hideModelProviderHint: false },
        target,
    );
    const patched = target.addChild;
    const same = installModelSelectorHintPatch(
        { compactModelSelector: false, hideModelProviderHint: false },
        target,
    );
    assert.equal(same, handle);
    assert.equal(target.addChild, patched);
    const spacer = new Spacer();
    target.addChild(spacer);
    assert.deepEqual(target.addedComponents, [spacer]);
    handle.dispose();
});

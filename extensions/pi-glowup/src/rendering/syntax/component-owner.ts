import type { Component } from "@earendil-works/pi-tui";
import { observeSyntaxHighlightSource, retireSyntaxHighlightSource } from "./highlighter.ts";

type SyntaxComponentOwner = {
    component: Component | undefined;
    invalidateHost: (() => void) | undefined;
    readonly invalidate: () => void;
};

const owners = new WeakMap<Component, SyntaxComponentOwner>();

function createOwner(): SyntaxComponentOwner {
    const owner: SyntaxComponentOwner = {
        component: undefined,
        invalidateHost: undefined,
        invalidate: () => {
            owner.component?.invalidate();
            owner.invalidateHost?.();
        },
    };

    return owner;
}

export function createSyntaxComponent(
    previous: Component | undefined,
    invalidateHost: (() => void) | undefined,
    render: (invalidate: () => void, previous: Component | undefined) => Component,
    source?: string,
): Component {
    let owner: SyntaxComponentOwner | undefined;
    if (previous !== undefined) owner = owners.get(previous);
    if (owner?.component === undefined) owner = undefined;
    owner ??= createOwner();
    owner.invalidateHost = invalidateHost;
    if (source !== undefined) observeSyntaxHighlightSource(source, owner.invalidate);

    const component = render(owner.invalidate, owner.component);
    owner.component = component;
    owners.set(component, owner);

    return component;
}

export function retireSyntaxComponent(component: Component): void {
    const owner = owners.get(component);
    if (owner?.component === undefined) return;

    owner.component = undefined;
    owner.invalidateHost = undefined;
    retireSyntaxHighlightSource(owner.invalidate);
}

export function inheritSyntaxComponent(component: Component, source: Component): void {
    const owner = owners.get(source);
    if (owner === undefined) {
        owners.delete(component);
    } else {
        owners.set(component, owner);
    }
}

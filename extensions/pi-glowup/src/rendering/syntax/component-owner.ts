import type { Component } from "@earendil-works/pi-tui";

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
    render: (invalidate: () => void) => Component,
): Component {
    let owner: SyntaxComponentOwner | undefined;
    if (previous !== undefined) owner = owners.get(previous);
    owner ??= createOwner();
    owner.invalidateHost = invalidateHost;

    const component = render(owner.invalidate);
    owner.component = component;
    owners.set(component, owner);

    return component;
}

export function inheritSyntaxComponent(component: Component, source: Component): void {
    const owner = owners.get(source);
    if (owner === undefined) {
        owners.delete(component);
    } else {
        owners.set(component, owner);
    }
}

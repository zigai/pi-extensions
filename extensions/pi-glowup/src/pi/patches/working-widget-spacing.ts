import { Container, Loader, Spacer, type Component } from "@earendil-works/pi-tui";

const WORKING_WIDGET_SPACING_PATCH_STATE_KEY = Symbol.for(
    "zigai.pi-glowup.working-widget-spacing.state",
);

type WorkingWidgetSpacingPatchState = {
    enabled: boolean;
    readonly originalRender: typeof Container.prototype.render;
    readonly wrapperRender: typeof Container.prototype.render;
};

type PatchableContainerPrototype = typeof Container.prototype & {
    [WORKING_WIDGET_SPACING_PATCH_STATE_KEY]?: WorkingWidgetSpacingPatchState;
};

function isSingleLineSpacer(component: Component): boolean {
    if (!(component instanceof Spacer)) {
        return false;
    }

    const lines = component.render(1);
    return lines.length === 1 && lines[0] === "";
}

function isEmptySpacerContainer(component: Component): boolean {
    return (
        component instanceof Container &&
        component.children.length === 1 &&
        component.children[0] !== undefined &&
        isSingleLineSpacer(component.children[0])
    );
}

function isLoaderContainer(component: Component | undefined): boolean {
    return (
        component instanceof Container &&
        component.children.length === 1 &&
        component.children[0] instanceof Loader
    );
}

/**
 * Removes Pi's empty above-editor spacer while a status loader is visible.
 *
 * Pi renders the working indicator in the status container, then renders an empty
 * above-editor widget container that contains a single spacer. The combination
 * leaves an extra blank line directly above the input box during streaming.
 */
/** Enables or disables the working-widget spacing prototype patch. */
export function configureWorkingWidgetSpacingPatch(
    enabled: boolean,
    prototype: PatchableContainerPrototype = Container.prototype,
): void {
    const containerPrototype = prototype;
    const state = containerPrototype[WORKING_WIDGET_SPACING_PATCH_STATE_KEY];
    if (!enabled) {
        if (state !== undefined) {
            state.enabled = false;

            if (containerPrototype.render === state.wrapperRender) {
                containerPrototype.render = state.originalRender;
                delete containerPrototype[WORKING_WIDGET_SPACING_PATCH_STATE_KEY];
            }
        }

        return;
    }

    if (state !== undefined) {
        state.enabled = true;
        return;
    }

    const originalRender = containerPrototype.render;
    let nextState: WorkingWidgetSpacingPatchState;
    const wrapperRender = function renderWithWorkingWidgetSpacing(
        this: Container,
        width: number,
    ): string[] {
        if (!nextState.enabled) {
            return originalRender.call(this, width);
        }

        const lines: string[] = [];
        let previousChild: Component | undefined;
        for (const child of this.children) {
            if (isLoaderContainer(previousChild) && isEmptySpacerContainer(child)) {
                previousChild = child;
                continue;
            }

            const childLines = child.render(width);
            for (const line of childLines) {
                lines.push(line);
            }

            previousChild = child;
        }

        return lines;
    };

    nextState = {
        enabled: true,
        originalRender: originalRender,
        wrapperRender,
    };
    containerPrototype.render = wrapperRender;
    containerPrototype[WORKING_WIDGET_SPACING_PATCH_STATE_KEY] = nextState;
}

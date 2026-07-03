import { Container, Loader, Spacer, type Component } from "@earendil-works/pi-tui";

const WORKING_WIDGET_SPACING_PATCH_KEY = Symbol.for("zigai.pi-codex-look.working-widget-spacing");

type PatchableContainerPrototype = typeof Container.prototype & {
  [WORKING_WIDGET_SPACING_PATCH_KEY]?: true;
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
export function installWorkingWidgetSpacingPatch(prototype: object = Container.prototype): void {
  const containerPrototype = prototype as PatchableContainerPrototype;
  if (containerPrototype[WORKING_WIDGET_SPACING_PATCH_KEY] === true) {
    return;
  }

  containerPrototype.render = function renderWithWorkingWidgetSpacing(
    this: Container,
    width: number,
  ): string[] {
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

  containerPrototype[WORKING_WIDGET_SPACING_PATCH_KEY] = true;
}

import { MouseRegion, type Component } from "@earendil-works/pi-tui";
import Type, { type Static } from "typebox";
import { Value } from "typebox/value";
import { inheritSyntaxComponent } from "../rendering/syntax/component-owner.ts";

const expansionSchema = Type.Object({
    global: Type.Boolean(),
    call: Type.Optional(Type.Boolean()),
    result: Type.Optional(Type.Boolean()),
});
const rendererStateSchema = Type.Object(
    { glowupSectionExpansion: Type.Optional(expansionSchema) },
    { additionalProperties: true },
);

type SectionExpansion = Static<typeof expansionSchema>;
type Section = "call" | "result";

const sectionComponents = new WeakMap<Component, Component>();

export function sectionContent(component: Component | undefined): Component | undefined {
    if (component === undefined) return undefined;
    return sectionComponents.get(component) ?? component;
}

type SectionContext = {
    readonly state?: unknown;
    readonly expanded: boolean;
    readonly invalidate?: () => void;
};

function expansionState(context: SectionContext): SectionExpansion | undefined {
    if (context.state === undefined) return undefined;

    const state = Value.Parse(rendererStateSchema, context.state);
    const current = state.glowupSectionExpansion;
    if (current !== undefined && current.global === context.expanded) return current;

    const expansion: SectionExpansion = { global: context.expanded };
    state.glowupSectionExpansion = expansion;
    return expansion;
}

export function renderExpandableSection(
    context: SectionContext,
    section: Section,
    render: (expanded: boolean, probe: boolean) => Component,
): Component {
    const expansion = expansionState(context);
    const expanded = expansion?.[section] ?? context.expanded;
    const component = render(expanded, false);
    const invalidate = context.invalidate;
    if (expansion === undefined || invalidate === undefined) return component;

    const region = new MouseRegion(component, (event) => {
        if (event.type !== "click" || event.button !== "left") return undefined;

        const collapsedLines = render(false, true).render(event.width);
        const expandedLines = render(true, true).render(event.width);
        if (
            collapsedLines.length === expandedLines.length &&
            collapsedLines.every((line, index) => line === expandedLines[index])
        ) {
            return { handled: true };
        }

        expansion[section] = !expanded;
        invalidate();

        return { handled: true };
    });

    inheritSyntaxComponent(region, component);
    sectionComponents.set(region, component);

    return region;
}

export const FOOTER_COMPONENT_MARKER = Symbol.for("zigai.pi-footer.component");
export const FOOTER_COMPONENT_KIND = Symbol.for("zigai.pi-footer.component-kind");

export type FooterComponentKind = "live" | "bridge";

export type MarkedFooterComponent = {
    [FOOTER_COMPONENT_MARKER]: true;
    [FOOTER_COMPONENT_KIND]: FooterComponentKind;
};

export function isFooterComponent(value: unknown): value is MarkedFooterComponent {
    if ((typeof value !== "object" && typeof value !== "function") || value === null) {
        return false;
    }

    return (
        FOOTER_COMPONENT_MARKER in value &&
        value[FOOTER_COMPONENT_MARKER] === true &&
        FOOTER_COMPONENT_KIND in value &&
        (value[FOOTER_COMPONENT_KIND] === "live" || value[FOOTER_COMPONENT_KIND] === "bridge")
    );
}

export function markFooterComponent<T extends object>(
    component: T,
    kind: FooterComponentKind,
): T & MarkedFooterComponent {
    Object.defineProperty(component, FOOTER_COMPONENT_MARKER, {
        configurable: false,
        enumerable: false,
        value: true,
    });
    Object.defineProperty(component, FOOTER_COMPONENT_KIND, {
        configurable: true,
        enumerable: false,
        value: kind,
    });

    if (!isFooterComponent(component) || component[FOOTER_COMPONENT_KIND] !== kind) {
        throw new Error("Failed to mark footer component.");
    }

    return component;
}

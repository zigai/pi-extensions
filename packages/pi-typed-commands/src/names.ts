/** Convert camelCase, dotted, or underscored identifiers to lower-kebab CLI spelling. */
export function toKebabCase(name: string): string {
    return name
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .replace(/[_.]/g, "-")
        .toLowerCase();
}

/** Canonicalize a user-supplied flag spelling to its no-leading-dash kebab form. */
export function normalizeFlagName(name: string): string {
    return toKebabCase(name.trim().replace(/^--?/, ""));
}

/** Format an identifier as a normalized long CLI flag with leading `--`. */
export function formatFlagName(name: string): string {
    return `--${toKebabCase(name)}`;
}

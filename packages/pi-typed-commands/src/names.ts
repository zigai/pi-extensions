export function toKebabCase(name: string): string {
    return name
        .replace(/([a-z0-9])([A-Z])/g, "$1-$2")
        .replace(/_/g, "-")
        .toLowerCase();
}

export function normalizeFlagName(name: string): string {
    return toKebabCase(name.trim().replace(/^--?/, ""));
}

export function formatFlagName(name: string): string {
    return `--${toKebabCase(name)}`;
}

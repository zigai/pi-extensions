import { getStylePrefix, type HighlightStyles } from "./highlight-text.ts";
import type { HighlightColor, MessageHighlightsConfig, ThemeForegroundColor } from "./settings.ts";

const ESC = String.fromCharCode(0x1b);
const CUBE_VALUES = [0, 95, 135, 175, 215, 255] as const;
const GRAY_VALUES = Array.from({ length: 24 }, (_unused, index) => 8 + index * 10);

type ColorMode = "truecolor" | "256color";

export type HighlightTheme = {
    fg(color: ThemeForegroundColor, text: string): string;
    getColorMode(): ColorMode;
};

type RgbColor = {
    readonly red: number;
    readonly green: number;
    readonly blue: number;
};

function parseHexColor(hex: `#${string}`): RgbColor {
    const value = hex.slice(1);
    if (!/^[0-9a-fA-F]{6}$/.test(value)) {
        throw new Error(`Invalid hex color: ${hex}`);
    }

    return {
        red: parseInt(value.slice(0, 2), 16),
        green: parseInt(value.slice(2, 4), 16),
        blue: parseInt(value.slice(4, 6), 16),
    };
}

function colorDistance(
    red: number,
    green: number,
    blue: number,
    nextRed: number,
    nextGreen: number,
    nextBlue: number,
): number {
    const redDelta = red - nextRed;
    const greenDelta = green - nextGreen;
    const blueDelta = blue - nextBlue;
    return redDelta * redDelta + greenDelta * greenDelta + blueDelta * blueDelta;
}

function findClosestCubeIndex(value: number): number {
    let minimumDistance = Infinity;
    let minimumIndex = 0;
    for (let index = 0; index < CUBE_VALUES.length; index += 1) {
        const nextValue = CUBE_VALUES[index] ?? 0;
        const distance = Math.abs(value - nextValue);
        if (distance < minimumDistance) {
            minimumDistance = distance;
            minimumIndex = index;
        }
    }

    return minimumIndex;
}

function findClosestGrayIndex(gray: number): number {
    let minimumDistance = Infinity;
    let minimumIndex = 0;
    for (let index = 0; index < GRAY_VALUES.length; index += 1) {
        const value = GRAY_VALUES[index] ?? 0;
        const distance = Math.abs(gray - value);
        if (distance < minimumDistance) {
            minimumDistance = distance;
            minimumIndex = index;
        }
    }

    return minimumIndex;
}

function rgbToAnsi256({ red, green, blue }: RgbColor): number {
    const redIndex = findClosestCubeIndex(red);
    const greenIndex = findClosestCubeIndex(green);
    const blueIndex = findClosestCubeIndex(blue);
    const cubeIndex = 16 + 36 * redIndex + 6 * greenIndex + blueIndex;
    const cubeRed = CUBE_VALUES[redIndex] ?? 0;
    const cubeGreen = CUBE_VALUES[greenIndex] ?? 0;
    const cubeBlue = CUBE_VALUES[blueIndex] ?? 0;
    const cubeDistance = colorDistance(red, green, blue, cubeRed, cubeGreen, cubeBlue);
    const gray = Math.round(0.299 * red + 0.587 * green + 0.114 * blue);
    const grayIndex = findClosestGrayIndex(gray);
    const grayValue = GRAY_VALUES[grayIndex] ?? 0;
    const grayColorIndex = 232 + grayIndex;
    const grayDistance = colorDistance(red, green, blue, grayValue, grayValue, grayValue);
    const spread = Math.max(red, green, blue) - Math.min(red, green, blue);
    if (spread < 10 && grayDistance < cubeDistance) {
        return grayColorIndex;
    }

    return cubeIndex;
}

function getHexPrefix(color: `#${string}`, theme: HighlightTheme | undefined): string {
    const rgb = parseHexColor(color);

    try {
        if (theme?.getColorMode() === "256color") {
            return `${ESC}[38;5;${rgbToAnsi256(rgb)}m`;
        }
    } catch {
        return `${ESC}[38;2;${rgb.red};${rgb.green};${rgb.blue}m`;
    }

    return `${ESC}[38;2;${rgb.red};${rgb.green};${rgb.blue}m`;
}

function getThemePrefix(theme: HighlightTheme | undefined, color: ThemeForegroundColor): string {
    if (theme === undefined) return "";

    try {
        return getStylePrefix((text: string) => theme.fg(color, text));
    } catch {
        // Theme may not be initialized yet during early startup renders.
        // Later renders will retry and pick up the native color.
        return "";
    }
}

function getColorPrefix(color: HighlightColor, theme: HighlightTheme | undefined): string {
    let prefix: string;
    switch (color.kind) {
        case "none":
            prefix = "";
            break;
        case "theme":
            prefix = getThemePrefix(theme, color.color);
            break;
        case "ansi256":
            prefix = `${ESC}[38;5;${color.color}m`;
            break;
        case "hex":
            prefix = getHexPrefix(color.color, theme);
            break;
    }

    return prefix;
}

export function buildHighlightStyles(
    theme: HighlightTheme | undefined,
    config: MessageHighlightsConfig,
): HighlightStyles {
    return {
        url: getColorPrefix(config.urlColor, theme),
        filepath: getThemePrefix(theme, "accent"),
    };
}

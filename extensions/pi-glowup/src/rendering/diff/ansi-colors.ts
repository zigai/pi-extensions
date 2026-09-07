import ansiStyles from "ansi-styles";

type Rgb = {
    readonly red: number;
    readonly green: number;
    readonly blue: number;
};

const ANSI_256_CUBE_LEVELS = [0, 95, 135, 175, 215, 255] as const;
const MIN_DIFF_SHADE_DISTANCE = 28;
const DIFF_SHADE_BLEND_STEP = 0.04;
const MAX_DIFF_SHADE_BLEND = 0.4;

/** Returns a stronger semantic background while retaining the base row tint. */
export function strongerDiffBackgroundAnsi(
    rowBackgroundAnsi: string,
    semanticForegroundAnsi: string,
): string | undefined {
    const row = ansiRgb(rowBackgroundAnsi, 48);
    const semantic = ansiRgb(semanticForegroundAnsi, 38);
    if (row === undefined || semantic === undefined) {
        return undefined;
    }

    let strongest = contrastingBlend(semantic, row);
    if (rgbDistance(strongest, row) < MIN_DIFF_SHADE_DISTANCE) {
        const black = { red: 0, green: 0, blue: 0 };
        const white = { red: 255, green: 255, blue: 255 };
        const anchor = rgbDistance(row, black) > rgbDistance(row, white) ? black : white;
        strongest = contrastingBlend(anchor, semantic, row);
    }

    if (rowBackgroundAnsi.includes("48;5;")) {
        return ansiStyles.bgColor.ansi256(closestDistinctAnsi256(strongest, row));
    }

    return ansiStyles.bgColor.ansi16m(strongest.red, strongest.green, strongest.blue);
}

function contrastingBlend(front: Rgb, back: Rgb, comparison: Rgb = back): Rgb {
    let strongest = back;

    for (
        let amount = DIFF_SHADE_BLEND_STEP;
        amount <= MAX_DIFF_SHADE_BLEND;
        amount += DIFF_SHADE_BLEND_STEP
    ) {
        strongest = blendRgb(front, back, amount);
        if (rgbDistance(strongest, comparison) >= MIN_DIFF_SHADE_DISTANCE) {
            break;
        }
    }

    return strongest;
}

function ansiRgb(ansi: string, channel: 38 | 48): Rgb | undefined {
    const trueColor = new RegExp(`${channel};2;(\\d+);(\\d+);(\\d+)`, "u").exec(ansi);
    if (trueColor !== null) {
        const red = boundedChannel(trueColor[1]);
        const green = boundedChannel(trueColor[2]);
        const blue = boundedChannel(trueColor[3]);
        return red === undefined || green === undefined || blue === undefined
            ? undefined
            : { red, green, blue };
    }

    const indexed = new RegExp(`${channel};5;(\\d+)`, "u").exec(ansi);
    const index = boundedAnsiIndex(indexed?.[1]);
    return index === undefined ? undefined : ansi256Rgb(index);
}

function boundedChannel(value: string | undefined): number | undefined {
    const channel = Number(value);
    return Number.isInteger(channel) && channel >= 0 && channel <= 255 ? channel : undefined;
}

function boundedAnsiIndex(value: string | undefined): number | undefined {
    const index = Number(value);
    return Number.isInteger(index) && index >= 0 && index <= 255 ? index : undefined;
}

function ansi256Rgb(index: number): Rgb {
    if (index < 16) {
        const basic = [
            [0, 0, 0],
            [128, 0, 0],
            [0, 128, 0],
            [128, 128, 0],
            [0, 0, 128],
            [128, 0, 128],
            [0, 128, 128],
            [192, 192, 192],
            [128, 128, 128],
            [255, 0, 0],
            [0, 255, 0],
            [255, 255, 0],
            [0, 0, 255],
            [255, 0, 255],
            [0, 255, 255],
            [255, 255, 255],
        ] as const;
        const [red, green, blue] = basic[index] ?? basic[0];
        return { red, green, blue };
    }

    if (index < 232) {
        const cube = index - 16;

        return {
            red: ANSI_256_CUBE_LEVELS[Math.floor(cube / 36)] ?? 0,
            green: ANSI_256_CUBE_LEVELS[Math.floor((cube % 36) / 6)] ?? 0,
            blue: ANSI_256_CUBE_LEVELS[cube % 6] ?? 0,
        };
    }

    const gray = 8 + (index - 232) * 10;
    return { red: gray, green: gray, blue: gray };
}

function closestDistinctAnsi256(target: Rgb, row: Rgb): number {
    let closestIndex = 0;
    let closestDistance = Number.POSITIVE_INFINITY;
    for (let index = 0; index <= 255; index += 1) {
        const candidate = ansi256Rgb(index);
        if (rgbDistance(candidate, row) < MIN_DIFF_SHADE_DISTANCE) {
            continue;
        }

        const distance = rgbDistance(candidate, target);
        if (distance < closestDistance) {
            closestDistance = distance;
            closestIndex = index;
        }
    }

    return closestIndex;
}

function blendRgb(front: Rgb, back: Rgb, amount: number): Rgb {
    const blend = (frontChannel: number, backChannel: number): number =>
        Math.round(backChannel + (frontChannel - backChannel) * amount);

    return {
        red: blend(front.red, back.red),
        green: blend(front.green, back.green),
        blue: blend(front.blue, back.blue),
    };
}

function rgbDistance(left: Rgb, right: Rgb): number {
    return Math.hypot(left.red - right.red, left.green - right.green, left.blue - right.blue);
}

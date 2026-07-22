const graphemeSegmenter = new Intl.Segmenter("en", { granularity: "grapheme" });

function graphemes(value: string): string[] {
    return Array.from(graphemeSegmenter.segment(value), ({ segment }) => segment);
}

export function takeGraphemePrefix(value: string, maximum: number): string {
    if (maximum <= 0) return "";
    const segments = graphemes(value);
    return segments.length <= maximum ? value : segments.slice(0, maximum).join("");
}

export function takeGraphemeSuffix(value: string, maximum: number): string {
    if (maximum <= 0) return "";
    const segments = graphemes(value);
    return segments.length <= maximum ? value : segments.slice(-maximum).join("");
}

export function truncateGraphemeText(value: string, maximum: number): string {
    if (maximum <= 0) return "";
    const segments = graphemes(value);
    if (segments.length <= maximum) return value;
    if (maximum === 1) return "…";
    return `${segments.slice(0, maximum - 1).join("")}…`;
}

export function chunkGraphemeText(value: string, maximum: number): string[] {
    if (maximum <= 0) return [];
    const segments = graphemes(value);
    const chunks: string[] = [];
    for (let index = 0; index < segments.length; index += maximum) {
        chunks.push(segments.slice(index, index + maximum).join(""));
    }
    return chunks;
}

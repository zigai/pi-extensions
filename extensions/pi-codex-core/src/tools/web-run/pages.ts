import { Type } from "typebox";

import { compileSchema } from "../../schema-parsing.ts";
import { FAILED_FETCH, INACCESSIBLE_URL } from "./output.ts";

/** Codex marks each result section's new page id at the start of the line below its header. */
const PAGE_MARKER = /^(?:\u{e200}cite\u{e202}|【)(turn\d+[a-z]+\d+)(?:\u{e201}|】)/gmu;

const HEADER_URL = /\((https?:\/\/\S+?)(?:\s;[^)]*)?\)\s*$/u;
const OPEN_SOURCE = /Source: open\((\{[^}]*\})\)/u;
const SourceSchema = compileSchema(Type.Object({ ref_id: Type.String() }));

/** Page URLs by the ids Codex assigned them, across every web_run output of the session. */
export class WebRunPageIndex {
    readonly #urls = new Map<string, string>();

    reset(outputs: Iterable<string>): void {
        this.#urls.clear();

        for (const output of outputs) this.record(output);
    }

    record(rawOutput: string): void {
        const markers = [...rawOutput.matchAll(PAGE_MARKER)];
        for (const [index, marker] of markers.entries()) {
            const refId = marker[1];
            if (refId === undefined) continue;

            const header = rawOutput.slice(0, marker.index).replace(/\r?\n$/u, "");
            const headerLine = header.slice(header.lastIndexOf("\n") + 1);
            const body = rawOutput.slice(marker.index, markers[index + 1]?.index);
            const url = HEADER_URL.exec(headerLine)?.[1] ?? this.#failedSectionUrl(body);
            if (url !== undefined) this.#urls.set(refId, url);
        }
    }

    url(refId: string): string | undefined {
        return this.#urls.get(refId);
    }

    #failedSectionUrl(body: string): string | undefined {
        const failure = FAILED_FETCH.exec(body) ?? INACCESSIBLE_URL.exec(body);
        if (failure?.[1] !== undefined) return failure[1];

        const source = OPEN_SOURCE.exec(body)?.[1];
        if (source === undefined) return undefined;

        let parsed: unknown;
        try {
            parsed = JSON.parse(source);
        } catch {
            return undefined;
        }

        const refId = SourceSchema.decode(parsed)?.ref_id;
        if (refId === undefined) return undefined;
        return /^https?:\/\//u.test(refId) ? refId : this.#urls.get(refId);
    }
}

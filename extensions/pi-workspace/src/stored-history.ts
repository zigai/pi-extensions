import type { ExtensionContext, SessionEntry } from "@earendil-works/pi-coding-agent";
import { Type, type StaticDecode } from "typebox";
import { Value } from "typebox/value";
import { Compile } from "typebox/compile";

const storedValueSchema = Type.Cyclic(
    {
        Value: Type.Union([
            Type.Null(),
            Type.Boolean(),
            Type.Number(),
            Type.String(),
            Type.Array(Type.Ref("Value")),
            Type.Record(Type.String(), Type.Ref("Value")),
        ]),
    },
    "Value",
);
const storedValues = Compile(storedValueSchema);
const stringValue = Type.String();
const numberValue = Type.Number();
const booleanValue = Type.Boolean();

export type HistoryScope = "branch" | "all";

export type StoredEntry = {
    readonly id: string;
    readonly timestamp: string;
    readonly kind: string;
    readonly text: string;
    readonly onCurrentBranch: boolean;
};

type StoredValue = StaticDecode<typeof storedValueSchema>;

type IndexedEntry = {
    readonly entry: StoredEntry;
    readonly searchable: string;
};

function storedContent(entry: SessionEntry): string {
    const stored = storedValues.Decode(JSON.parse(JSON.stringify(entry)));
    const content: string[] = [];

    JSON.stringify(stored, (key: string, value: StoredValue): StoredValue => {
        if (key.length > 0) content.push(key);
        if (Value.Check(stringValue, value)) content.push(value);

        if (Value.Check(numberValue, value) || Value.Check(booleanValue, value)) {
            content.push(String(value));
        }

        return value;
    });

    return content.join("\n");
}

export class StoredHistory {
    private readonly entries = new Map<string, IndexedEntry>();

    constructor(session: ExtensionContext["sessionManager"]) {
        const branch = new Set(session.getBranch().map((entry) => entry.id));
        for (const entry of session.getEntries()) {
            const text = JSON.stringify(entry, null, 2);

            this.entries.set(entry.id, {
                entry: {
                    id: entry.id,
                    timestamp: entry.timestamp,
                    kind: entry.type,
                    text,
                    onCurrentBranch: branch.has(entry.id),
                },
                searchable: storedContent(entry).toLowerCase(),
            });
        }
    }

    list(scope: HistoryScope = "branch"): readonly StoredEntry[] {
        return this.scopedEntries(scope).map((record) => record.entry);
    }

    search(query: string, scope: HistoryScope = "branch"): readonly StoredEntry[] {
        if (query.length === 0) return [];

        const literal = query.toLowerCase();

        return this.scopedEntries(scope)
            .filter((record) => record.searchable.includes(literal))
            .map((record) => record.entry);
    }

    open(id: string): StoredEntry | undefined {
        return this.entries.get(id)?.entry;
    }

    private scopedEntries(scope: HistoryScope): readonly IndexedEntry[] {
        const entries = [...this.entries.values()];
        if (scope === "all") return entries;

        return entries.filter((record) => record.entry.onCurrentBranch);
    }
}

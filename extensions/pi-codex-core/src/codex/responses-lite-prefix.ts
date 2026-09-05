import { createHash } from "node:crypto";
import type { ResponsesInputItem, JsonValue } from "../compaction/types.ts";

const UUID_NAMESPACE_OID = Buffer.from("6ba7b8129dad11d180b400c04fd430c8", "hex");

export function buildResponsesLitePrefix(
    sessionId: string,
    tools: readonly JsonValue[],
    instructions: string,
): readonly [ResponsesInputItem, ...ResponsesInputItem[]] {
    const namespace = uuidV5Bytes(UUID_NAMESPACE_OID, sessionId);
    return [
        {
            type: "additional_tools",
            id: `at_${formatUuid(uuidV5Bytes(namespace, JSON.stringify(tools)))}`,
            role: "developer",
            tools,
        },
        ...(instructions.length > 0
            ? [
                  {
                      type: "message",
                      id: `msg_${formatUuid(uuidV5Bytes(namespace, instructions))}`,
                      role: "developer",
                      content: [{ type: "input_text", text: instructions }],
                  },
              ]
            : []),
    ];
}

function uuidV5Bytes(namespace: Uint8Array, content: string): Buffer {
    const bytes = createHash("sha1")
        .update(namespace)
        .update(content, "utf8")
        .digest()
        .subarray(0, 16);
    bytes.writeUInt8((bytes.readUInt8(6) & 0x0f) | 0x50, 6);
    bytes.writeUInt8((bytes.readUInt8(8) & 0x3f) | 0x80, 8);
    return bytes;
}

function formatUuid(bytes: Uint8Array): string {
    const hex = Buffer.from(bytes).toString("hex");
    return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

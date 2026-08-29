import type { CompactionEntry } from "@earendil-works/pi-coding-agent";

import type { ScheduledTask } from "../runtime.ts";
import { NATIVE_COMPACTION_STRATEGY } from "./messages.ts";

export type JsonPrimitive = string | number | boolean | null;
export type JsonValue = JsonPrimitive | JsonObject | readonly JsonValue[];
export type JsonObject = { readonly [key: string]: JsonValue | undefined };

export type ResponsesInputItem = JsonObject;

export type CompactionTextBlock = {
    readonly type: "text";
    readonly text: string;
};

export type CompactionImageBlock = {
    readonly type: "image";
    readonly data: string;
    readonly mimeType: string;
    readonly detail?: "auto" | "high" | "original" | undefined;
};

export type CompactionThinkingBlock = {
    readonly type: "thinking";
    readonly thinking?: string | undefined;
    readonly thinkingSignature?: string | undefined;
    readonly redacted?: boolean | undefined;
};

export type CompactionToolCallBlock = {
    readonly type: "toolCall";
    readonly id: string;
    readonly name: string;
    readonly arguments?: JsonObject | undefined;
};

export type CompactionContentBlock =
    | CompactionTextBlock
    | CompactionImageBlock
    | CompactionThinkingBlock
    | CompactionToolCallBlock;

export type CompactionMessageContent = readonly CompactionContentBlock[];

export type CompactionMessage =
    | {
          readonly role: "user";
          readonly content: CompactionMessageContent;
      }
    | {
          readonly role: "assistant";
          readonly content: readonly CompactionContentBlock[];
          readonly provider?: string | undefined;
          readonly api?: string | undefined;
          readonly model?: string | undefined;
          readonly stopReason?: string | undefined;
      }
    | {
          readonly role: "toolResult";
          readonly toolCallId?: string | undefined;
          readonly content: readonly CompactionContentBlock[];
      };

/** Provider-serialized Responses tool definition, retained without schema rewriting. */
export type ResponsesTool = JsonObject;

export type ProviderRequestLayout = "responses" | "responses-lite";

/** Static, cache-shaping fields captured from a real provider request. */
export type ProviderRequestTemplate = {
    readonly model: string;
    readonly layout: ProviderRequestLayout;
    readonly activeToolNames?: readonly string[] | undefined;
    readonly instructions: string;
    readonly tools?: readonly ResponsesTool[] | undefined;
    readonly additionalToolsItem?: ResponsesInputItem | undefined;
    readonly instructionItems?: readonly ResponsesInputItem[] | undefined;
    readonly promptCacheKey?: string | undefined;
    readonly reasoning?: RemoteCompactionReasoning | undefined;
    readonly serviceTier?: string | undefined;
};

export type NativeCompactionRequestMeta = {
    readonly previousCompactionEntryId?: string | undefined;
    readonly retainedInputItems: number;
    readonly rewrittenToolOutputs: number;
    readonly estimatedTokensBefore: number;
    readonly estimatedTokensAfter: number;
    readonly budgetTokens?: number | undefined;
    readonly providerTemplateUsed?: boolean | undefined;
    readonly inputTokens?: number | undefined;
    readonly cachedInputTokens?: number | undefined;
};

export type NativeCompactionWorldState = {
    readonly cwd: string;
    readonly model: string;
    readonly activeToolNames: readonly string[];
    readonly readFiles: readonly string[];
    readonly modifiedFiles: readonly string[];
    readonly capturedAt: string;
};

export type NativeCompactionDetails = {
    readonly strategy: typeof NATIVE_COMPACTION_STRATEGY;
    readonly provider: string;
    readonly api: string;
    readonly model: string;
    readonly compHash?: string | undefined;
    readonly baseUrl: string;
    readonly compactedWindow: readonly ResponsesInputItem[];
    readonly windowNumber: number;
    readonly windowId: string;
    readonly firstWindowId: string;
    readonly previousWindowId?: string | undefined;
    readonly sourceCompactionEntryId?: string | undefined;
    readonly worldState: NativeCompactionWorldState;
    readonly compactResponseId?: string | undefined;
    readonly createdAt: string;
    readonly requestMeta?: NativeCompactionRequestMeta | undefined;
};

export type NativeCompactionEntry = CompactionEntry<NativeCompactionDetails> & {
    readonly details: NativeCompactionDetails;
};

export type RemoteCompactionV2Response = {
    readonly compactionOutput: ResponsesInputItem;
    readonly id?: string | undefined;
    readonly createdAt?: number | string | undefined;
    readonly usage?: RemoteCompactionUsage | undefined;
};

export type RemoteCompactionUsage = {
    readonly inputTokens?: number | undefined;
    readonly cachedInputTokens?: number | undefined;
};

export type RemoteCompactionV2Request = {
    readonly model: string;
    readonly instructions?: string | undefined;
    readonly input: readonly ResponsesInputItem[];
    readonly tool_choice: "auto";
    readonly parallel_tool_calls: boolean;
    readonly store: false;
    readonly stream: true;
    readonly include: readonly string[];
    readonly prompt_cache_key: string;
    readonly text: { readonly verbosity: string };
    readonly service_tier?: "priority" | undefined;
    readonly reasoning?: RemoteCompactionReasoning | undefined;
    readonly tools?: readonly ResponsesTool[] | undefined;
    readonly client_metadata?: Readonly<Record<string, string>> | undefined;
};

export type RemoteCompactionReasoning = JsonObject;

export type ResponsesPayload = JsonObject & {
    readonly model: string;
    readonly input: readonly ResponsesInputItem[];
    readonly instructions?: JsonValue | undefined;
};

export type NativeCompactionMatch = {
    readonly provider: string;
    readonly api: string;
    readonly baseUrl: string;
};

export type FoundNativeCompactionEntry = {
    readonly entry: NativeCompactionEntry;
    readonly index: number;
};

export type BuildPromptInputResult = {
    readonly input: readonly ResponsesInputItem[];
    readonly previousCompactionEntryId?: string | undefined;
};

export type RemoteCompactionRequestParts = {
    readonly model: string;
    readonly instructions: string;
    readonly promptCacheKey: string;
    readonly verbosity: string;
    readonly fast: boolean;
    readonly reasoning?: RemoteCompactionReasoning | undefined;
    readonly tools?: readonly ResponsesTool[] | undefined;
    readonly clientMetadata?: Readonly<Record<string, string>> | undefined;
    readonly requestTemplate?: ProviderRequestTemplate | undefined;
};

export type RemoteCompactionPreflightResult = {
    readonly input: readonly ResponsesInputItem[];
    readonly rewrittenToolOutputs: number;
    readonly estimatedTokensBefore: number;
    readonly estimatedTokensAfter: number;
};

export type TokenEstimateCache = {
    readonly objectTokens: WeakMap<object, number>;
    readonly textTokens: Map<string, number>;
};

export type ShrinkRemoteCompactionRequestResult =
    | {
          readonly kind: "ok";
          readonly request: RemoteCompactionV2Request;
          readonly promptInput: readonly ResponsesInputItem[];
          readonly rewrittenToolOutputs: number;
          readonly estimatedTokensBefore: number;
          readonly estimatedTokensAfter: number;
          readonly budgetTokens?: number | undefined;
      }
    | {
          readonly kind: "too_large";
          readonly rewrittenToolOutputs: number;
          readonly estimatedTokensBefore: number;
          readonly estimatedTokensAfter: number;
          readonly budgetTokens: number;
      };

export type NativeReplayResult =
    | { readonly ok: true; readonly payload: ResponsesPayload }
    | { readonly ok: false; readonly reason: string };

export type AutoCompactionSessionState = {
    readonly lastTriggeredEntryId?: string | undefined;
    readonly blockedEntryId?: string | undefined;
    readonly inFlight: boolean;
    readonly timer?: ScheduledTask | undefined;
};

export type AgentEndCompactionMessage = {
    readonly role?: string | undefined;
    readonly stopReason?: string | undefined;
};

export type ScheduleCodexAutoCompactionOptions = {
    readonly completedMessages?: readonly AgentEndCompactionMessage[] | undefined;
};

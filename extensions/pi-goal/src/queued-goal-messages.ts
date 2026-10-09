import { Type, type Static } from "typebox";
import { Value } from "typebox/value";

import { CUSTOM_ENTRY_TYPE } from "./types.ts";

type GoalQueuedWorkKind = "continuation" | "command_start" | "command_resume";

export interface ActiveGoalQueuedDetails {
  kind: GoalQueuedWorkKind;
  goalId: string;
}

export interface QueuedGoalTextPart {
  readonly type: "text";
  readonly text: string;
}

export type QueuedGoalUserContent = QueuedGoalTextPart[];

const QueuedGoalTextPartSchema = Type.Object({
  type: Type.Literal("text"),
  text: Type.String(),
});
const QueuedGoalTimestampSchema = Type.Number();
const QueuedGoalContentPartsSchema = Type.Array(Type.Unknown());
const QueuedGoalContentCandidateSchema = Type.Union([Type.String(), QueuedGoalContentPartsSchema]);

type QueuedGoalContentCandidate = Static<typeof QueuedGoalContentCandidateSchema>;

/** External provider-context message shape before normalization. */
export interface QueuedGoalContextInput {
  role: string;
  customType?: string;
  content?: unknown;
  display?: boolean;
  details?: unknown;
  timestamp?: unknown;
}

/** Normalized provider-context carrier with required runtime fields. */
export interface QueuedGoalContextCarrier {
  role: string;
  timestamp: number;
  customType?: string;
  content?: unknown;
  display?: boolean;
  details?: unknown;
}

export interface QueuedGoalCustomMessage extends QueuedGoalContextCarrier {
  role: "custom";
  customType: typeof CUSTOM_ENTRY_TYPE;
  content: string | QueuedGoalUserContent;
  display: boolean;
}

export interface QueuedGoalUserMessage extends QueuedGoalContextCarrier {
  role: "user";
  content: QueuedGoalUserContent;
}

export type QueuedGoalWorkSourceMessage = QueuedGoalCustomMessage | QueuedGoalUserMessage;

/** Role/customType only — does not prove normalized content or display. */
interface QueuedGoalCustomRoleCarrier {
  role: "custom";
  customType: typeof CUSTOM_ENTRY_TYPE;
}

function isQueuedGoalCustomRole(
  message: QueuedGoalContextCarrier,
): message is QueuedGoalContextCarrier & QueuedGoalCustomRoleCarrier {
  return message.role === "custom" && message.customType === CUSTOM_ENTRY_TYPE;
}

function parseQueuedGoalTextParts(candidates: readonly unknown[]): QueuedGoalUserContent {
  const parts: QueuedGoalTextPart[] = [];
  for (const candidate of candidates) {
    try {
      parts.push(Value.Parse(QueuedGoalTextPartSchema, candidate));
    } catch {
      // Provider content may mix non-text parts; queued-goal work preserves only text.
    }
  }

  return parts;
}

export function userContentFromUnknown(content: unknown): QueuedGoalUserContent {
  try {
    const candidates = Value.Parse(QueuedGoalContentPartsSchema, content);
    return parseQueuedGoalTextParts(candidates);
  } catch {
    return [];
  }
}

function parseQueuedGoalContentCandidate(content: unknown): QueuedGoalContentCandidate | null {
  try {
    return Value.Parse(QueuedGoalContentCandidateSchema, content);
  } catch {
    return null;
  }
}

function customContentFromUnknown(content: unknown): string | QueuedGoalUserContent {
  const candidate = parseQueuedGoalContentCandidate(content);
  if (candidate === null) {
    return "";
  }

  if (Array.isArray(candidate)) {
    const normalized = parseQueuedGoalTextParts(candidate);
    return normalized.length > 0 ? normalized : "";
  }

  return candidate;
}

export function textContentFromUnknown(content: unknown): string | null {
  try {
    const candidate = Value.Parse(QueuedGoalContentCandidateSchema, content);
    if (!Array.isArray(candidate)) {
      return candidate;
    }

    const parts = parseQueuedGoalTextParts(candidate);

    return parts.length === 0 ? null : parts.map((part) => part.text).join("\n");
  } catch {
    return null;
  }
}

/** Copies provider-context fields into a carrier with the runtime-required timestamp. */
export function toQueuedGoalContextCarrier(
  message: QueuedGoalContextInput,
): QueuedGoalContextCarrier | null {
  let timestamp: number;
  try {
    timestamp = Value.Parse(QueuedGoalTimestampSchema, message.timestamp);
  } catch {
    return null;
  }

  const carrier: QueuedGoalContextCarrier = {
    role: message.role,
    timestamp,
  };
  if (message.customType !== undefined) {
    carrier.customType = message.customType;
  }

  if (message.content !== undefined) {
    carrier.content = message.content;
  }

  if (message.display !== undefined) {
    carrier.display = message.display;
  }

  if (message.details !== undefined) {
    carrier.details = message.details;
  }

  return carrier;
}

/** Narrows a carrier to queued-goal user/custom work and normalizes its content. */
export function toQueuedGoalWorkSource(
  message: QueuedGoalContextCarrier,
): QueuedGoalWorkSourceMessage | null {
  switch (message.role) {
    case "user":
      return {
        ...message,
        role: "user",
        content: userContentFromUnknown(message.content),
      };
    case "custom": {
      if (!isQueuedGoalCustomRole(message)) {
        return null;
      }

      const normalized: QueuedGoalCustomMessage = {
        role: "custom",
        customType: message.customType,
        timestamp: message.timestamp,
        content: customContentFromUnknown(message.content),
        display: message.display ?? false,
      };
      if (message.details !== undefined) {
        normalized.details = message.details;
      }

      return normalized;
    }
    default:
      return null;
  }
}

export function isActiveGoalQueuedDetails(details: unknown): details is ActiveGoalQueuedDetails {
  if (details === null || typeof details !== "object") {
    return false;
  }

  if (!("kind" in details) || !("goalId" in details)) {
    return false;
  }

  const kind = details.kind;
  return (
    (kind === "continuation" || kind === "command_start" || kind === "command_resume") &&
    typeof details.goalId === "string"
  );
}

export function isCommandResumeQueuedGoalMessage(message: QueuedGoalContextCarrier): boolean {
  return (
    isQueuedGoalCustomRole(message) &&
    isActiveGoalQueuedDetails(message.details) &&
    message.details.kind === "command_resume"
  );
}

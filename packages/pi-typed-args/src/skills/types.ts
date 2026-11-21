import type {
    ArgumentDefinition,
    ArgumentDefinitions,
    ArgumentUi,
    ArgumentValue,
    ArgumentWidget,
    BooleanArgumentDefinition,
    DefinitionDiagnostic,
    EnumArgumentDefinition,
    FlatArgumentDefinitions,
    MultiEnumArgumentDefinition,
    StringListArgumentDefinition,
    KeyValueArgumentDefinition,
    NumberArgumentDefinition,
    StringArgumentDefinition,
} from "../types.ts";

export type {
    ArgumentDefinition,
    ArgumentDefinitions,
    ArgumentUi,
    ArgumentValue,
    ArgumentWidget,
    BooleanArgumentDefinition,
    EnumArgumentDefinition,
    FlatArgumentDefinitions,
    MultiEnumArgumentDefinition,
    StringListArgumentDefinition,
    KeyValueArgumentDefinition,
    NumberArgumentDefinition,
    StringArgumentDefinition,
};

export type RawSkillArgumentDefinition = Record<string, unknown>;
export type RawSkillArguments = Record<string, unknown>;

export type SkillFrontmatterMetadata = Readonly<Record<string, unknown>> & {
    readonly ghostText?: string;
};

export type SkillFrontmatter = {
    name?: string;
    description?: string;
    formTitle?: string;
    metadata?: SkillFrontmatterMetadata;
    arguments?: unknown;
};

export type ParseSkillMarkdownResult =
    | { status: "ok"; frontmatter: SkillFrontmatter; body: string }
    | { status: "invalid"; body: string; diagnostics: readonly SkillArgumentDiagnostic[] };

export type TypedSkillMetadata = {
    name: string;
    description: string;
    filePath: string;
    baseDir: string;
    body: string;
    args: FlatArgumentDefinitions;
    formTitle?: string;
    ghostText?: string;
};

export type SkillArgumentDiagnostic = DefinitionDiagnostic;

export type TypedSkillDiagnostics = {
    name: string;
    filePath: string;
    diagnostics: readonly SkillArgumentDiagnostic[];
};

export type SkillArgumentNormalizationResult = {
    args: FlatArgumentDefinitions;
    diagnostics: readonly SkillArgumentDiagnostic[];
};

export type ReadTypedSkillMetadataResult =
    | { status: "absent" }
    | { status: "ok"; metadata: TypedSkillMetadata }
    | { status: "invalid"; diagnostics: TypedSkillDiagnostics };

export type ReadTypedSkillMetadataOptions = {
    /** Stable skill name to use when malformed frontmatter prevents reading `name`. */
    fallbackName?: string;
};

export type RenderTypedSkillInvocationOptions = {
    skill: Pick<TypedSkillMetadata, "name" | "filePath" | "baseDir" | "body">;
    values: Readonly<Record<string, ArgumentValue>>;
    additionalInput?: string;
};

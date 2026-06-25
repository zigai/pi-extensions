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
    NumberArgumentDefinition,
    StringArgumentDefinition,
} from "../types.js";

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
    NumberArgumentDefinition,
    StringArgumentDefinition,
};

/** Untrusted YAML object for one typed skill argument before normalization. */
export type RawSkillArgumentDefinition = Record<string, unknown>;

/** Untrusted YAML `arguments` map from a skill frontmatter block. */
export type RawSkillArguments = Record<string, unknown>;

/** Parsed subset of `SKILL.md` frontmatter used by typed skill support. */
export type SkillFrontmatter = {
    name?: string;
    description?: string;
    formTitle?: string;
    arguments?: unknown;
};

/** Normalized metadata for a skill that declares typed arguments. */
export type TypedSkillMetadata = {
    name: string;
    description: string;
    filePath: string;
    baseDir: string;
    body: string;
    args: FlatArgumentDefinitions;
    formTitle?: string;
};

/** Structured diagnostic produced while normalizing typed skill frontmatter. */
export type SkillArgumentDiagnostic = DefinitionDiagnostic;

/** Schema diagnostics for a skill whose typed arguments could not be registered. */
export type TypedSkillDiagnostics = {
    name: string;
    filePath: string;
    diagnostics: readonly SkillArgumentDiagnostic[];
};

/** Result of normalizing raw skill YAML into command argument definitions. */
export type SkillArgumentNormalizationResult = {
    /** Successfully normalized argument definitions keyed by argument path. */
    args: FlatArgumentDefinitions;
    /** Structured authoring diagnostics that should be shown before using the typed skill. */
    diagnostics: readonly SkillArgumentDiagnostic[];
};

/** Result of reading typed metadata from one `SKILL.md` file. */
export type ReadTypedSkillMetadataResult = {
    metadata?: TypedSkillMetadata;
    diagnostics?: TypedSkillDiagnostics;
};

/** Inputs for rendering a typed skill invocation into the prompt sent to the model. */
export type RenderTypedSkillInvocationOptions = {
    skill: Pick<TypedSkillMetadata, "name" | "filePath" | "baseDir" | "body">;
    values: Readonly<Record<string, ArgumentValue>>;
    additionalInput?: string;
};

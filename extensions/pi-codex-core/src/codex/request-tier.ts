import type { OpenAICodexResponsesOptions, Provider, StreamOptions } from "@earendil-works/pi-ai";
import { installLinkedMethodPatch } from "@zigai/pi-extension-internals";
import { Type } from "typebox";
import { compileSchema } from "../schema-parsing.ts";

type PayloadHook = NonNullable<StreamOptions["onPayload"]>;

const REQUEST_TIER_WRAPPER = Symbol.for("pi-codex-core.provider-request-tier.v1");
const payloadHooks = new WeakSet<PayloadHook>();
const handleSchema = Type.Object({ dispose: Type.Function([], Type.Void()) });
const handleDecoder = compileSchema(handleSchema);
const installationDecoder = compileSchema(
    Type.Object({
        version: Type.Literal(1),
        acquire: Type.Function([], handleSchema),
    }),
);

const requestOptionsDecoder = compileSchema(
    Type.Object(
        { onPayload: Type.Function([Type.Unknown(), Type.Unknown()], Type.Unknown()) },
        { additionalProperties: true },
    ),
);

const serviceTierPayloadDecoder = compileSchema(
    Type.Object(
        {
            service_tier: Type.Optional(
                Type.Enum(["auto", "default", "flex", "priority", "scale"] as const),
            ),
        },
        { additionalProperties: true },
    ),
);

function tierOptions<Options extends StreamOptions>(options: Options | undefined) {
    // oxlint-disable-next-line antislop/no-unknown-parameters -- The SDK supplies an untyped callback receiver, validated before use.
    const onPayload: PayloadHook = async function (this: unknown, payload, model) {
        // SDK simple streams clone options. The method receiver is the exact
        // request-local clone that the SDK later consults for pricing.
        const receiver = requestOptionsDecoder.decode(this);
        if (receiver === undefined || !payloadHooks.has(receiver.onPayload))
            throw new Error("Codex SDK payload hook did not expose its request options.");

        const rewritten = await options?.onPayload?.call(receiver, payload, model);
        const effectivePayload = rewritten ?? payload;
        Object.assign(receiver, { serviceTier: requestedServiceTier(effectivePayload) });

        return rewritten;
    };

    payloadHooks.add(onPayload);

    return Object.assign({}, options, { onPayload });
}

/** Keep Codex's SDK pricing fallback aligned with the final, rewritten request. */
export function installCodexRequestTierWrapper(
    provider: Provider,
): { dispose(): void } | undefined {
    const existing = Object.getOwnPropertyDescriptor(provider, REQUEST_TIER_WRAPPER);
    if (existing !== undefined) {
        const installation = installationDecoder.decode(existing.value);
        if (installation === undefined)
            throw new Error("Unsupported Codex request-tier registration.");

        return handleDecoder.Parse(installation.acquire());
    }

    if (typeof provider.stream !== "function" || typeof provider.streamSimple !== "function")
        return undefined;

    const stream = installLinkedMethodPatch(
        provider,
        "stream",
        (predecessor) =>
            function (model, context, options) {
                if (model.api !== "openai-codex-responses")
                    return predecessor.call(this, model, context, options);

                return predecessor.call(this, model, context, tierOptions(options));
            },
    );

    try {
        const simple = installLinkedMethodPatch(
            provider,
            "streamSimple",
            (predecessor) =>
                function (model, context, options) {
                    if (model.api !== "openai-codex-responses")
                        return predecessor.call(this, model, context, options);

                    return predecessor.call(this, model, context, tierOptions(options));
                },
        );

        let owners = 0;
        let disposed = false;
        const acquire = () => {
            if (disposed) throw new Error("Codex request-tier registration was disposed.");

            owners += 1;

            let released = false;

            return {
                dispose() {
                    if (released) return;

                    if (owners === 1) {
                        simple.dispose();
                        stream.dispose();

                        if (
                            Object.getOwnPropertyDescriptor(provider, REQUEST_TIER_WRAPPER)
                                ?.value === marker
                        )
                            Reflect.deleteProperty(provider, REQUEST_TIER_WRAPPER);

                        disposed = true;
                    }

                    owners -= 1;
                    released = true;
                },
            };
        };
        const marker = { version: 1, acquire };
        try {
            Object.defineProperty(provider, REQUEST_TIER_WRAPPER, {
                value: marker,
                configurable: true,
            });
        } catch (cause) {
            simple.dispose();
            throw cause;
        }

        return acquire();
    } catch (cause) {
        stream.dispose();
        throw cause;
    }
}

function requestedServiceTier(payload: unknown): OpenAICodexResponsesOptions["serviceTier"] {
    return serviceTierPayloadDecoder.decode(payload)?.service_tier;
}

# Cooperative tool activation

Pi Toggles offers an optional event protocol for extensions that have useful standalone tool defaults but should not compete with a central policy manager.

## Ownership model

- Extensions always register their own tool implementations.
- An extension applies its normal activation behavior until Pi Toggles accepts its proposal.
- After acceptance, that extension publishes updated proposals instead of calling `setActiveTools()`.
- Pi Toggles applies proposals below session, project, and global user policy.
- Conflicting extension proposals have no implicit winner. Pi Toggles preserves the inherited state and reports the conflict through `/toggles doctor` until user policy resolves it.

Pi exposes only the winning implementation for a duplicated tool name. This protocol coordinates activation; it cannot select between multiple extensions that register the same name. Keep one implementation owner for each canonical tool name.

## Handshake

All payloads are strict, versioned objects. Unknown fields, unsupported versions, malformed identifiers, and unsupported states are rejected.

After its session service is ready, Pi Toggles emits:

```ts
pi.events.emit("pi-toggles:activation-ready", {
  version: 1,
  sessionId,
});
```

A companion responds with its complete current proposal:

```ts
pi.events.emit("pi-toggles:set-activation-proposal", {
  version: 1,
  sessionId,
  owner: "example-extension",
  decisions: [
    { target: { kind: "tool", name: "example_tool" }, state: "on" },
    { target: { kind: "tool", name: "edit" }, state: "off" },
  ],
});
```

Allowed proposal states are `inherit`, `on`, `off`, and `lazy`. Targets may optionally include Pi `sourceInfo.source` and `sourceInfo.path` values.

Pi Toggles stores the latest proposal per owner and synchronously emits:

```ts
pi.events.emit("pi-toggles:activation-proposal-accepted", {
  version: 1,
  sessionId,
  owner: "example-extension",
});
```

Only this acceptance event transfers activation ownership. A ready event without acceptance must leave the companion in standalone mode.

An extension that withdraws its proposal during a live session can emit:

```ts
pi.events.emit("pi-toggles:clear-activation-proposal", {
  version: 1,
  sessionId,
  owner: "example-extension",
});
```

Session shutdown discards all proposals automatically.

## Lifecycle requirements

Companion extensions should subscribe during factory execution so either extension load order works. Keep the latest session ID and desired decisions in memory:

1. Before acceptance, apply the extension's standalone activation behavior.
2. On `activation-ready`, publish the current session proposal.
3. On matching `activation-proposal-accepted`, stop mutating active tools.
4. On model or extension-setting changes, publish a complete replacement proposal.
5. Recreate coordination state after reload or session replacement and remove event listeners during shutdown.

Pi Toggles waits for proposals submitted during its own startup handler and always settles pending reconciliation again before each agent run.

## Precedence

The effective order, highest first, is:

1. Active Goal restrictions
2. Session overrides and profiles
3. Project overrides and profiles
4. Global overrides and profiles
5. Project and global rules
6. Extension activation proposals
7. Pi's inherited active state

Activation proposals remain defaults. Goal publishes `goal.status` and a current-session restriction snapshot; acceptance transfers tool-set ownership to Toggles. Ending the restriction recomputes remaining policy rather than blindly enabling tools.

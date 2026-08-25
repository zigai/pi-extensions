# Pi Extension Settings

Persistent, typed settings for [Pi](https://github.com/earendil-works/pi) extensions. Define one TypeBox schema and reuse it for runtime types, validation, defaults, editor schemas, and user documentation.

## Install

Using [Pi Extension Template](https://github.com/zigai/pi-extension-template) is the recommended way to create a new extension. It generates the settings structure, commands, and runtime loader for you.

To add settings to an existing extension:

```sh
npm install @zigai/pi-extension-settings
```

Then follow [Add settings to an existing Pi extension](docs/manual-setup.md).

## Features

- Typed defaults and decoded runtime values from one TypeBox schema
- Global settings with optional trusted-project overrides
- Generated `config.schema.json` and README configuration documentation
- A checked-in prevalidation artifact for the Pi runtime path
- Safe diagnostics that do not expose setting values
- Locked, validated, atomic settings updates when an extension needs to write configuration

## Runtime model

Settings resolve in a predictable order:

```text
schema defaults ← global settings ← trusted-project settings
```

Project settings override global settings, and global settings override defaults. Nested object fields are combined; lists and individual values are replaced. Invalid settings are skipped and reported. Existing files are never overwritten automatically.

To keep startup fast, load settings once per session, when the extension first needs them. To disable an extension without loading it, disable its package in Pi's configuration.

## Documentation

- [Add settings to an existing Pi extension](docs/manual-setup.md)
- [Generated artifacts and command behavior](docs/generation.md)
- [Runtime loading and transactional updates](docs/runtime.md)
- [Optional settings-editor controls](docs/ui-controls.md)
- [Generate a complete extension with Pi Extension Template](https://github.com/zigai/pi-extension-template)

## License

[MIT](LICENSE)

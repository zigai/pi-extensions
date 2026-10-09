# Optional UI controls

The optional `x-control` TypeBox annotation tells compatible settings editors how to present a property. It does not change validation, defaults, or runtime loading.

[Pi Settings UI](https://github.com/zigai/pi-settings-ui) supports these values:

| `x-control`   | Compatible schema           | Presentation                                                            |
| ------------- | --------------------------- | ----------------------------------------------------------------------- |
| `text`        | string                      | Single-line input                                                       |
| `textarea`    | string                      | Multiline editor                                                        |
| `switch`      | boolean                     | Toggle                                                                  |
| `segmented`   | primitive choices           | Compact choice control                                                  |
| `select`      | primitive choices           | Searchable picker                                                       |
| `slider`      | number or integer           | Range control using schema bounds and `multipleOf`                      |
| `numeric`     | number or integer           | Numeric input                                                           |
| `color`       | string                      | Text input with a hexadecimal color preview                             |
| `path`        | string                      | Text input with Tab completion                                          |
| `combobox`    | string or string-only union | Suggestions from `examples` or union branches, plus custom valid values |
| `json-editor` | any property schema         | Validated JSON editor                                                   |

Pass the annotation as a quoted schema option:

```ts
const enabled = Type.Boolean({
  default: true,
  description: "Enable the extension's behavior.",
  "x-control": "switch",
});
```

Choose a control only when it communicates the setting more clearly than the editor's schema-derived default.

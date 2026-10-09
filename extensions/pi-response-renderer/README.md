# Pi Response Renderer

<a href="https://www.npmjs.com/package/@zigai/pi-response-renderer"><img alt="npm version" src="https://img.shields.io/npm/v/@zigai/pi-response-renderer.svg?color=blue" style="display:inline-block;border:0" /></a> <a href="https://www.npmjs.com/package/@zigai/pi-response-renderer"><img alt="npm downloads" src="https://img.shields.io/npm/dm/@zigai/pi-response-renderer.svg" style="display:inline-block;border:0" /></a> <a href="https://github.com/zigai/pi-tweaks/blob/master/LICENSE"><img alt="license" src="https://img.shields.io/npm/l/@zigai/pi-response-renderer.svg" style="display:inline-block;border:0" /></a>

Compact assistant response rendering for Pi.

It applies a few small rendering tweaks:

- hides the visible ``` fence lines around rendered Markdown code blocks in assistant messages
- collapses paragraph gaps without squeezing tables or headings
- removes italic ANSI styling from assistant message output

## Install

```sh
pi install npm:@zigai/pi-response-renderer
```

The extension only changes how messages are rendered in the UI. It does not rewrite saved conversation content.

## Screenshots

Before:

![Pi Response Renderer before screenshot](assets/response-renderer-before.png)

After:

![Pi Response Renderer after screenshot](assets/response-renderer-after.png)

## License

MIT

# Pi Codex Core

Pi extension for codex core.

## Install

```sh
pi install git:github.com/zigai/pi-codex-core
```

For this private package on this machine, load the local working copy from Pi settings:

```json
{
  "packages": ["/home/zigai/Projects/pi-codex-core"]
}
```

## Extension

This package starts with an empty Pi extension in `src/index.ts`.

## Development

```sh
npm install
just check
just coverage
```

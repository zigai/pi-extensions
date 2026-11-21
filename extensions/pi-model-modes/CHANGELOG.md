# Changelog

## Unreleased

### Changed

- Fresh startup and `/new` now use the first configured cycle mode, including its thinking level and appearance. Resume, fork, and reload preserve the active selection.
- The mode picker marks the startup entry and offers **Move to first / use on startup** instead of a separate default-model picker.
- Mode order changes and renames persist without overwriting concurrent reorders. Startup and cycling use the same trusted-project settings resolution.
- The `defaultModel` setting is removed. Settings files that still contain it fail validation.

# Changelog

## 0.1.0 - 2026-05-06

- Initial public release.
- Adds Codex-style `/goal` tracking for pi.
- Adds model-callable `get_goal`, `create_goal`, and `update_goal` tools.
- Persists goal state in pi session custom entries for resume, reload, fork, tree navigation, and compaction.
- Starts and resumes goals with hidden follow-up messages so active objectives keep moving.
- Shows live elapsed active time and compact/exact token counts in the pi footer.

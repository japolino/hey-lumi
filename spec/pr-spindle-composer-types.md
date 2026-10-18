Adds types for `ctx.composer`, the chat composer bridge. Companion to the Lumiverse PR (prolix-oc/Lumiverse#TBD).

- `SpindleComposerAPI`: `getState()`, `onChange(handler)`, `setText(text)`, `insertText(text, { at?: "caret" | "end" })`, `focus()`, `send(): Promise<void>`. Reading, editing and focus are free; `send` needs `generation` and runs the host's own send path (persona, attachments, group targeting, multiplayer rules).
- `SpindleComposerState`: `{ mounted, chatId, text }`, read-only. `mounted: false` when no composer is on screen; the write methods and `send` then throw `COMPOSER_UNAVAILABLE`.
- `SpindleComposerInsertPosition`: `"caret" | "end"`.
- `SpindleFrontendContext.composer?: SpindleComposerAPI` (optional, for older hosts).
- New frontend-only host capability `composer-v1: 1` (`SPINDLE_COMPOSER_HOST_CAPABILITIES`), like `client-info-v1`.

Also adds a consumer type test (`test/api-composer-consumer.ts`) and a capability test, and rebuilds dist. The version is not bumped.

Checks: `npm run build`, `tsc -p tsconfig.consumer.json --noEmit`, `bun test` (18 pass), `npm run build:consumer`.

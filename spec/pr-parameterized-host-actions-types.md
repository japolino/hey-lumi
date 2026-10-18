Adds types for parameterized host actions in `ctx.host.surfaces`. Companion to the Lumiverse PR (https://github.com/prolix-oc/Lumiverse/pull/476).

- `SpindleHostSurfaceKind` adds `"entity_action"`.
- `SpindleHostEntityActionId` = `"switch_persona" | "switch_preset" | "apply_theme" | "character_chat"`.
- `SpindleHostSurfaceInfo.params?: SpindleHostActionParamsSchema`. This is a JSON Schema subset that describes the params of an `entity_action`: `{ type: "object"; properties: Record<string, SpindleHostActionParamSchema>; required: string[]; additionalProperties: false }`.
- `SpindleHostActionParamSchema` = `{ type: "string"; description; enum?; oneOf?: Array<{ const; title }> }`. `oneOf` lists known values with names, for example the themes `apply_theme` accepts.

Params for the actions (all strings): `switch_persona { personaId }`, `switch_preset { presetId }`, `apply_theme { themeId }`, `character_chat { characterId, mode: "latest" | "new" }`. `invoke()` keeps its existing `SpindleHostActionParams` type.

Also adds a consumer type test (`test/api-host-entity-actions-consumer.ts`) and rebuilds dist (`dist/dom.d.ts`, `dist/index.d.ts`). The version is not bumped. No new host capability: callers detect the actions with `surfaces.list(["entity_action"])`.

Checks: `npm run build`, `tsc -p tsconfig.consumer.json --noEmit` (via `npm run build:consumer`, which also verifies the packed ESM import), `bun test` (17 pass).

## Summary

`ctx.host.surfaces.invoke` cannot pass params to commands (`command` takes none), so an extension cannot say "switch to persona X" or "start a new chat with character Y". This PR adds a surface kind, `entity_action`, for a few host actions that need validated params. Each entry carries its param schema in `surfaces.list()`, so a caller (for example a voice or LLM planner) can discover the actions and their arguments.

Builds on #475 (generation commands); please merge that first. Types: https://github.com/prolix-oc/lumiverse-spindle-types/pull/69.

| Id | Params | Permission | Implementation |
| --- | --- | --- | --- |
| `switch_persona` | `{ personaId }` | `personas` | `selectPersona(id)`: the persona manager's switch, moved out of `usePersonaBrowser` into `lib/personaSelection.ts`. In a saved chat the choice is stored on the chat (`active_persona_id`), otherwise in the global setting. Unknown ids throw `HOST_ACTION_NOT_FOUND:personaId`. |
| `switch_preset` | `{ presetId }` | `presets` | `transitionActiveLoomPreset(id)`, the same coordinator the Loom panel uses. It saves pending edits of the previous preset first. Unknown ids reject (404). |
| `apply_theme` | `{ themeId }` | `app_manipulation` | A built-in theme preset id (`frontend/src/theme/presets.ts`) or a saved theme id (`savedThemes`). Presets go through `applyThemePreset`, which is the Theme panel's `handlePresetSelect` moved to `lib/themeSelection.ts` (it clears extension theme overrides and keeps the current mode). Saved themes go through the existing `applySavedTheme`. Unknown ids throw `HOST_ACTION_NOT_FOUND:themeId`. |
| `character_chat` | `{ characterId, mode: 'latest' \| 'new' }` | `chats` | `openCharacterChat` in `lib/characterChat.ts`. `latest` opens the most recently updated chat (`/chats/character-chats/:id` is ordered by `updated_at DESC`), or starts a chat when there is none. `new` always starts one. Starting a chat is `startCharacterChat`: the code that both `openChat` and `startNewChat` in `useCharacterBrowser` had, moved out once. So characters with alternate greetings still get the greeting picker. Unknown ids reject (404). |

What "theme id" means: the 9 built-in presets have stable slugs (`lumiverse-purple`, `emerald`, ...). Saved themes have UUIDs. There is no theme list API, so the `apply_theme` schema lists both kinds as `oneOf: [{ const: id, title: name }]`. It is built from the store and updates when the user saves a theme.

Schema shape (a JSON Schema subset, every param a string):

```json
{ "type": "object", "properties": { "characterId": { "type": "string", "description": "Character id" },
  "mode": { "type": "string", "description": "...", "enum": ["latest", "new"] } },
  "required": ["characterId", "mode"], "additionalProperties": false }
```

Validation is in the store-free `applyHostAction` switch (`host-actions.ts`), like the other kinds: unknown keys -> `HOST_ACTION_INVALID_PARAMS:<key>`, ids must match the existing `SAFE_ID` (`HOST_ACTION_INVALID_ID:<name>`), `mode` must be one of the two values. Authority rows: `entity_action:<id>` in `frontend-authority-map.ts`. The backend WebSocket UI bridge does not get these actions (its runtime leaves throw `HOST_ACTION_UNMAPPED`, like routes and modals).

Why a new kind and not params on commands: commands are palette entries that the user runs without arguments. A parameterized "command" could not run from the palette and would be a second kind of command. Routes and modals already take params the same way, so a separate kind fits the existing model.

Hook and component changes are moves, not behavior changes: `usePersonaBrowser.switchToPersona` keeps its toggle (choosing the active persona deactivates it) and calls `selectPersona`; `ThemePanel` passes `applyThemePreset` to `PresetGrid`; `useCharacterBrowser.openChat`/`startNewChat` keep their toasts and call `startCharacterChat`.

Feature detection: an action is available when it is in `list(['entity_action'])`; older hosts return no entries of this kind. No host capability flag; tell me if you prefer one.

Docs: new page `developer-docs/docs/frontend-api/host-surfaces.md` ("Host Navigation and Actions"). It covers `ctx.host.surfaces` (there was no page for it yet): kinds and params, the generation commands from the previous PR, and the entity actions.

`package.json` and `frontend/package.json` pin `lumiverse-spindle-types` to the types PR commit, because the frontend checks `ctx.host` against `SpindleHostSurfaceAPI` and needs the new kind.


## Validation

```text
bun x tsc --noEmit                          # 0 errors
cd frontend && bun run typecheck            # 0 errors
cd frontend && bun x eslint <changed files> # clean
cd frontend && bun test --isolate src       # 2899 pass, 1 fail
cd frontend && bun test --isolate src/lib/spindle src/lib/commands.generation.test.ts src/i18n   # after rebasing on the previous PR: 552 pass, 0 fail
```

The one failure in the full suite is `DesktopWindowChrome.contract.test.ts`. It also fails on the base branch.

New tests: `host-actions.test.ts` covers the dispatch of all four actions, plus missing, unsafe and extra params, a bad `mode`, and an unknown action id. `host-surfaces.test.ts` covers the listed schemas and theme `oneOf`, permission denial per action, `NOT_FOUND` for an unknown persona and theme, and a saved theme applied through the default runtime. The drift test checks the authority rows.

## Live test

A scratch Lumiverse from this branch (separate port and data dir), two characters (Mira with an alternate greeting), two personas, two Loom presets, one saved theme, and a throwaway frontend extension with `generation`, `chats`, `personas`, `presets` and `app_manipulation`:

| Case | Result |
| --- | --- |
| `list(['entity_action'])` | 4 entries with the schemas above; `themeId.oneOf` = 9 presets + "QA Saved Theme" |
| `switch_persona` Bea (home screen) | `persona.activeId` = Bea; server setting `activePersonaId` = Bea |
| `switch_persona` Ann inside a chat | chat metadata `active_persona_id` = Ann; active persona = Ann |
| `switch_persona` unknown / extra param | `HOST_ACTION_NOT_FOUND:personaId` / `HOST_ACTION_INVALID_PARAMS:x` |
| `switch_preset` Beta | `loom.activePresetId` = Beta, saved to the server after the settings debounce |
| `switch_preset` unknown | rejects with `404 Not Found`; the active preset is unchanged |
| `apply_theme` `emerald`, then the saved theme | `setting:theme` = Emerald, then "QA Saved Theme" (accent 10/70/50 shows in the CSS variables) |
| `apply_theme` unknown | `HOST_ACTION_NOT_FOUND:themeId` |
| `character_chat` Seo-yeon `latest` (no chats) | creates a chat and opens it |
| the same again | opens the same chat |
| `character_chat` Seo-yeon `new` | creates and opens a second chat |
| `character_chat` Mira `new` | the greeting picker opens |
| `character_chat` with `mode: 'oldest'` / unknown id | `HOST_ACTION_INVALID_PARAMS:mode` / rejects with `404 Not Found` |
| `presets` revoked | `switch_preset` throws `PERMISSION_DENIED:presets`; `switch_persona` still works |
| UI after the refactor | Theme panel "Rose" click applies Rose; persona manager double-click on Bea switches ("Switched to persona: Bea"), a second double-click deactivates ("Persona deactivated"); Characters drawer: Mira opens the greeting picker, Seo-yeon (2 chats) opens the chat picker |

## Required checklist

- [x] This pull request is based on the latest `staging` branch and targets `staging`, not `main`.
- [x] All applicable tests pass. The one full-suite failure also fails on the base branch.
- [x] I ran the relevant type check(s) with no type errors or warnings:
  - [x] Backend: `bun x tsc --noEmit`
  - [x] Frontend: `cd frontend && bun run typecheck`, `bun run lint` (eslint on the changed files)

## UI changes (if applicable)

- [ ] I validated this change in more than one browser.
- [ ] I verified the integrated experience on a mobile interface or through the mobile PWA.
- Browsers, devices, and PWA coverage: headless Chrome (desktop viewport) only. No visible UI changes; the Theme panel, persona manager and character browser call the moved functions.

## Security-sensitive changes (if applicable)

- Each action has one authority row and the permission of the matching backend API: `personas` (as `spindle.personas.switchActive`), `presets`, `chats` (it can create a chat), and `app_manipulation` for the theme (it replaces the user's theme and clears extension theme overrides).
- Params are validated before any runtime call: an allowlist of keys, the existing safe id pattern, and an enum for `mode`.
- `list()` is free like today. The `apply_theme` schema includes the names of the user's saved themes, which the session can already read through `GET /api/v1/settings/savedThemes`.

## LLM-assisted work (if applicable)

- [ ] I, as the human orchestrating this work, audited the submitted changes in a live environment.
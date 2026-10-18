## Summary

Three new command palette actions for generation control, plus two `ctx.host.surfaces` fixes for settings tabs. Voice control (and any other extension that drives the host through `ctx.host.surfaces`) needs these. They are also normal palette features for users.

- **New commands** in `frontend/src/lib/commands.ts`, with rows in `frontend-authority-map.ts`. They also appear in `ctx.host.surfaces.list(['command'])`:

  | Command | Label | Permission | Behavior |
  | --- | --- | --- | --- |
  | `action-stop-generation` | Stop Generation | `generation` | Calls `generateApi.stop(undefined, chatId)`. The backend then stops every generation of the active chat. It does nothing for a multiplayer room guest, the same rule as the stop button. While the stream has no generation id yet, it reverts the local stream like `InputArea.handleStop`. |
  | `action-swipe-left` | Previous Swipe | `chats` | `executeSwipe(lastAssistant, chatId, 'left')`. This is the same function the ArrowLeft shortcut uses. The swipe selection is a durable message write, like `action-toggle-hidden-last`. |
  | `action-swipe-right` | Next Swipe | `generation` | `executeSwipe(lastAssistant, chatId, 'right')`. After the last swipe of the last message it starts a new swipe generation (not while one is running). It respects the regen feedback modal. It uses `generation` because it can start a credentialed generation, like `action-regenerate`. |

  The scope is `chat` for all three. Moving between existing swipes is allowed while a generation runs, the same as the keyboard shortcut. All 8 locales have labels and descriptions; the swipe and stop labels reuse each locale's existing "Previous swipe" / "Next swipe" / "Stop generation" strings.
- **Settings tabs were missing from the live catalog.** `createHostSurfaceAPI`'s default inputs passed `state.settingsTabs` as the settings tab list. That store field holds extension settings tab *bodies* (`tabId`, `order`, ...), not tab entries; the `as unknown as SettingsTabEntry[]` cast hid this. So in a real page `surfaces.list(['settings_tab'])` returned `[]`, there were no `settings-*` commands, and `invoke({ kind: 'settings_tab', ... })` threw `HOST_ACTION_UNAVAILABLE`. The catalog now uses `getVisibleSettingsTabs(role)`, like the command palette.
- **`settings_tab` `anchorId` was validated but dropped.** The default runtime called `openSettings(id)` without it. It now passes `{ anchorId }`, so the settings modal scrolls to the section (`setsec-<tabId>-<sectionKey>`).
- **Regenerate description.** "Delete the last AI reply and generate a new one" was wrong: `regenerate` stages a new swipe on the last assistant message (`src/services/generate.service.ts`, the `genType === "regenerate" || genType === "swipe"` branch). The text is now "Generate a new swipe for the last AI reply" in all locales.

Not included: `action-impersonate`. Impersonation depends on composer state that lives in `InputArea` (the draft text, the impersonation mode and preset, oneshot guides), so it is not a small command.

## Validation

```text
bun x tsc --noEmit                         # 0 errors
cd frontend && bun run typecheck           # 0 errors
cd frontend && bun x eslint <changed files> # clean
cd frontend && bun test --isolate src/lib src/i18n src/hooks       # 1649 pass, 0 fail
cd frontend && bun test --isolate src/lib/spindle src/lib/commands.generation.test.ts   # 530 pass, 1 fail
```

The one failure is `dom-decorator-service.placements.test.tsx`, which timed out at 5 s under load; run alone it passes 15/15. The full frontend suite (`bun test --isolate src`, 2900 tests) has one failure, `DesktopWindowChrome.contract.test.ts`. It also fails without these changes.

New tests:
- `commands.generation.test.ts`: stop sends only the chat id; stop reverts the stream in its optimistic phase; stop is a no-op for a room guest and without a chat; both swipes target the last assistant message; no assistant message means nothing happens.
- `host-surfaces.test.ts`: the default catalog lists the core settings tabs and ignores extension tab bodies (this fails on staging), and the default settings runtime forwards `anchorId`.
- The existing drift test checks that the new command ids have authority rows.

## Live test

A scratch Lumiverse from this branch (stacked with the follow-up PR; separate port and data dir), a mock OpenAI-compatible server that streams 40 words over 12 s, and a throwaway frontend extension that calls `ctx.host.surfaces`:

| Case | Result |
| --- | --- |
| `list(['command'])` | has the three new commands with the labels and scopes above; Regenerate shows the new description |
| `action-regenerate`, then `action-stop-generation` after 3 s | the new swipe stops at 10 of 40 words; the stop button goes away; nothing more arrives in the next 10 s |
| `action-swipe-left` ×3 on a message with 3 swipes | swipe 2 -> 1 -> 0 -> 0 |
| `action-swipe-right` ×3 | 0 -> 1 -> 2 -> a new swipe 3 starts generating |
| `action-swipe-right` while that swipe streams | no second generation (still 4 swipes) |
| `action-swipe-left` while it streams | moves to swipe 2 |
| `list(['settings_tab'])` (owner) | 24 tabs and 24 `settings-*` commands; on staging it is empty |
| `settings_tab` `display` with `{ anchorId: 'setsec-display-chatHeads' }` | the section heading is at y=136; without the anchor it is at y=1293 (off screen) |
| permissions `generation` revoked | stop and next swipe throw `PERMISSION_DENIED:generation` |

## Required checklist

- [x] This pull request is based on the latest `staging` branch and targets `staging`, not `main`.
- [x] All applicable tests pass. The two failures above also fail without these changes, or pass when run alone.
- [x] I ran the relevant type check(s) with no type errors or warnings:
  - [x] Backend: `bun x tsc --noEmit`
  - [x] Frontend: `cd frontend && bun run typecheck`, `bun run lint` (eslint on the changed files)

## UI changes (if applicable)

- [ ] I validated this change in more than one browser.
- [ ] I verified the integrated experience on a mobile interface or through the mobile PWA.
- Browsers, devices, and PWA coverage: headless Chrome (desktop viewport) only.

## Security-sensitive changes (if applicable)

- The new commands follow the existing authority model: stop and next swipe need `generation` (next swipe can start a credentialed generation), previous swipe needs `chats` (durable swipe selection write).
- The settings tab fix only makes the existing free `settings_tab:*` / `command:settings-*` rows reachable. Role-gated tabs stay filtered by `getVisibleSettingsTabs(role)` and the existing invoke-time role check.

## LLM-assisted work (if applicable)

- [ ] I, as the human orchestrating this work, audited the submitted changes in a live environment.

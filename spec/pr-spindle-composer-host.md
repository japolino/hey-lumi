## Summary

Extensions cannot touch the chat composer today. The draft is React state inside `InputArea` (`const [text, setText] = useState('')`), and no store field, event or API exposes it. Dictation and voice tools have to set the textarea value through the DOM and dispatch a synthetic `input` event, and they cannot send the message the way the Send button does (persona name, attachments, group `@mention` targeting, multiplayer turn rules). The backend `chat.appendMessage` path names the message "User" and skips all of that.

This PR adds `ctx.composer`:

| Member | Permission | Behavior |
|---|---|---|
| `getState()` | free | `{ mounted, chatId, text }`; `{ mounted: false, chatId: null, text: '' }` when no composer is on screen |
| `onChange(handler)` | free | Called after the draft, the chat or the mounted state changes (typing, host actions, other extensions). Returns an unsubscribe function. |
| `setText(text)` | free | Replaces the draft |
| `insertText(text, { at })` | free | `'caret'` (default) replaces the selection and puts the caret after the new text; `'end'` appends |
| `focus()` | free | Focuses the textarea |
| `send()` | `generation` | Runs `InputArea`'s own `handleSend`, the same path as the Send button and Enter |

- **How it works**: `InputArea` registers a small controller in `frontend/src/lib/spindle/composer-api.ts` while it is mounted. Each extension gets a `ctx.composer` view over it. This follows the character editor helper (`setCharacterEditorController`, `getState`/`onChange`, a closed-state error).
- **Writes are synchronous**: `setText`/`insertText` use `flushSync`, so `getState()` or `send()` right after them see the new draft. `send()` reads the latest `handleSend` from a ref, so it uses the current persona, attachments and group settings.
- **onChange** is delivered in a microtask, so a handler can call back into the composer outside React's render and effect phases. Changes in the same task are delivered once, and unchanged states are skipped.
- **No composer mounted** (not on a chat page, or an extension replaced `InputArea` with a component override): `getState()` returns `mounted: false`; `setText`, `insertText`, `focus` and `send` throw `COMPOSER_UNAVAILABLE`.
- **Busy**: `send()` rejects with `COMPOSER_BUSY` while a send or a generation is running in the chat. (The Send button turns into Stop at that point, and `handleSend` would silently do nothing.) Host-side failures are shown as toasts, as for the Send button, and do not reject.
- **Permissions** (rows in `frontend-authority-map.ts`):
  - Reading is free: the draft is the value of the host textarea, which extension code in the main document can already read. `ctx.messages.getContent` is free on the same grounds.
  - Editing and focus are free: they only change transient UI state. Nothing is sent or stored on the server until the user sends. `ctx.chats.updateMessage` is `chats`-gated because it writes a stored message; a draft is not stored.
  - `send` needs `generation`, like the `action-regenerate` and `action-continue` commands (Rule-B clause (a)).
- **Feature detection**: host capability `composer-v1: 1` (frontend-only, like `client-info-v1`).
- **Docs**: new `developer-docs/docs/frontend-api/composer.md`, plus a row in the frontend API index and the nav entry.

Not included: a queue-only send (`Ctrl+Enter`), attachment access, or a "chat id must match" guard on writes. Callers can compare `getState().chatId` themselves.

Types: prolix-oc/lumiverse-spindle-types#TBD (`SpindleComposerAPI`, `SpindleComposerState`, `SpindleComposerInsertPosition`, `SPINDLE_COMPOSER_HOST_CAPABILITIES`, optional `ctx.composer` on `SpindleFrontendContext`). `frontend/package.json` points at that types commit until a package release includes it.

> Opener note (remove before opening): the frontend pin is `github:japolino/lumiverse-spindle-types#f1ca9326e9f8e2072d21cd9de1b04c5960a624c4`; switch it to `github:prolix-oc/lumiverse-spindle-types#<sha>` after the types PR is open, run `cd frontend && bun install`, and amend.

## Validation

```text
cd frontend && bun x tsc -b                         # 0 errors (bun run typecheck also passes on the clean branch base)
bun x tsc --noEmit                                  # root, 0 errors (no backend changes)
cd frontend && bun x eslint <the 9 changed .ts/.tsx files>   # 0 problems
cd frontend && bun test --isolate src/lib/spindle   # 530 pass, 0 fail (clean staging 2a8d9461: 524 pass, 0 fail; +6 new)
cd frontend && bun test --isolate src/components/chat   # 309 pass, 0 fail
```

New tests: `composer-api.test.ts` (unmounted state and errors, read/write/insert, `send` needs `generation`, one deduplicated `onChange` per burst including unmount, a stale unregister keeps the newer composer, unsubscribe/teardown/unload). The loader lifecycle contract gains a case (capability advertised, unmounted state, `PERMISSION_DENIED:generation`, `SPINDLE_FRONTEND_INACTIVE` after unload; contract count 27 -> 28). The authority-map test checks the new permissions.

## Live test

A scratch Lumiverse from this branch (separate port and data dir, built frontend), a Custom (OpenAI-compatible) connection pointing at a local mock LLM, and a throwaway frontend-only extension that exposes its `ctx.composer` to the page. Driven with Playwright in Chrome (desktop) and Edge (390x844 mobile emulation, touch).

| Case | Result |
|---|---|
| `ctx.host.capabilities['composer-v1']` | `1` |
| Typing "Hello" in the textarea | `onChange` got `H`, `He`, `Hel`, `Hell`, `Hello` |
| Caret after "He", `insertText('XY')` | draft and textarea `HeXYllo`, caret at 4, focus kept |
| Selection 0-2, `insertText('Oh ')` / `insertText(' end', { at: 'end' })` | `Oh XYllo` / `Oh XYllo end` |
| Textarea blurred, `insertText` at caret | inserted at the last caret, focus not taken |
| `setText('Replaced')` then `getState()` in the same task | `Replaced` in state and textarea; one `onChange` for the burst |
| `insertText('x', { at: 'start' })`, `setText(42)` | `TypeError` |
| `send()` without `generation` | `PERMISSION_DENIED:generation` |
| `send()` with `generation`, active persona Aria | user message named "Aria" with `persona_id`, draft cleared, mock reply streamed in; same result as pressing Enter |
| `send()` while a slow generation runs | `COMPOSER_BUSY`, the new draft is kept |
| Navigate to `/` | `onChange` with `mounted: false`; `setText`/`send` throw `COMPOSER_UNAVAILABLE` |
| Back to the chat / switch to another chat | `onChange` with `mounted: true` and the new `chatId` |
| Mobile emulation: `setText` + `send()` | message sent as "Aria", reply arrived |

No React `flushSync` warnings in the console.

## Required checklist

- [x] This pull request is based on the latest `staging` branch and targets `staging`, not `main`.
- [x] All applicable tests pass.
- [x] I ran the relevant type check(s) with no type errors or warnings:
  - [x] Backend: `bun x tsc --noEmit`
  - [x] Frontend: `cd frontend && bun run typecheck`, `bun run lint` (lint on the changed files)

## UI changes (if applicable)

- [ ] I validated this change in more than one browser.
- [ ] I verified the integrated experience on a mobile interface or through the mobile PWA.
- Browsers, devices, and PWA coverage: no visible UI change. The API was exercised in Chrome (desktop) and Edge with mobile emulation (390x844, touch, iPhone user agent); not on a real device or PWA.

## Security-sensitive changes (if applicable)

- New frontend `ctx` surface. Read, write and focus are free; `send` requires `generation` and is checked at call time through `assertCanonicalPermission` with a new authority row.
- Free reads expose only the current draft, which extension code in the main document can already read from the textarea. Free writes change only unsent, local UI state (and the local draft cache when draft saving is on); the user still decides whether to send.
- `send` cannot change the persona, connection, preset or attachments; it uses whatever the user has selected, through the existing send path and its multiplayer turn checks.

## LLM-assisted work (if applicable)

- [ ] I, as the human orchestrating this work, audited the submitted changes in a live environment.

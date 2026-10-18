# Lumi Voice: what a Lumiverse frontend extension can control (surface audit)

Audit date: 2026-10-18. Host: `prolix-oc/Lumiverse` `origin/staging` @ `2a8d9461` (read in a detached worktree).
Types: `lumiverse-spindle-types` `origin/main` @ `b4f0842` (0.6.52).
Paths below are relative to the Lumiverse repo unless they start with `types:` (= `lumiverse-spindle-types/src/`).
`SP/` = `frontend/src/lib/spindle/`.

**What I ran vs. what I only read.**
- RAN: the real `buildHostSurfaceCatalog()` (`SP/host-surfaces.ts:194`) plus `frontendAuthorityRowFor()` for every entry,
  with `bun test` in the scratch worktree (owner and plain-user role). Output: `spec/surface-catalog.json`
  (118 surfaces for an owner, 108 for a plain user; every core id has an authority row, none is unmapped).
- READ ONLY: everything else. No scratch instance was started; no claim below was tested in a browser.

---

## 1. How frontend extension code runs

**Main document, not an iframe.** The loader fetches `dist/frontend.js`, wraps it in a Blob URL and `import()`s it into
the Lumiverse page (`SP/loader.ts:613-630`, `:922-960`), then calls `setup(ctx)` (`SP/loader.ts:970-981`). The comment at
`SP/loader.ts:966-968` says it directly: "Frontend extensions still execute in the Lumiverse document context ...
Scriptable iframe content must opt into `ctx.dom.createSandboxFrame()`".

- Consequence: extension code has the same JS realm as Lumiverse: `document`, `window`, every host DOM node, `fetch` to the
  same origin with the session cookie. The page CSP only limits frames/objects/workers (`frontend/index.html:18`).
  There is no frontend bundle scanner (the install scanner only checks the backend bundle, `src/spindle/manager.service.ts:595`).
- The only enforced boundary is the `ctx` API: each gated `ctx` member checks the extension's granted permissions at call time
  (`SP/loader.ts:675-685` `assertCanonicalPermission`, `SP/frontend-domain-api.ts:269-272`).
  Raw DOM / raw REST access is *possible but not a contract* (selectors, CSS-module class names and routes can change, and a
  PR reviewer would not accept a design that bypasses permissions). Lumi Voice should use it only as a labelled fallback.
- `ctx.dom.createSandboxFrame()` (`SP/sandbox-frame.ts:108-195`) is an opt-in helper for isolated content:
  `sandbox="allow-scripts"`, `allow` denies microphone/camera/display-capture (`:123-127`), CSP `default-src 'none'`,
  `connect-src 'none'` (`:249`). Not useful for voice capture; Lumi Voice should run its mic/VAD/wake-word code in the main
  bundle (or a Worker it creates from a Blob; the page CSP allows `worker-src 'self' blob:`).

**What `ctx` offers** (built in `SP/loader.ts:1421-2185`, composed in `SP/frontend-context.ts:173-202`; public types
`types:dom.ts:1261-1500`). Relevant to voice:

| member | what it does | permission |
|---|---|---|
| `ctx.host.surfaces.list/subscribe/invoke` | host navigation + command catalog (section 2) | per entry, see below |
| `ctx.host.capabilities` | feature flags (`decisions-v1`, `decision-images-v1`, `speech-to-text-v1`, ...) | free |
| `ctx.stt.listProviders/prepare/start/transcribe` | host STT (`webspeech` / `connection` / `whistle`), `connectionId` optional (`types:speech-to-text.ts:44-88`) | `media` (list is free) (`SP/frontend-authority-map.ts:135,141-144`) |
| `ctx.state.get/subscribe(id)` | read-only selectors (`SP/state-selectors.ts:141-264`): `ui.activeModal`, `ui.drawer`, `ui.settings`, `ui.layout`, `chat.active` (chatId, characterId, avatarImageId), `chat.messageCount`, `characters.favorites`, `characters.browser`, `characters.editingId` (characters), `connections.active`, `connections.profiles`, `worldInfo.*`, `loom.activePresetId`, `persona.activeId`, and `setting:<key>` for 15 audited keys incl. `theme` (`SP/core-setting-keys.ts:42-58`) | free except `characters.editingId` |
| `ctx.connections.list/getActive/subscribe` | **LLM** connection profiles only (store `profiles`, api_key stripped) (`SP/frontend-domain-api.ts:300-320`) | free |
| `ctx.connections.setActive(id)` / `setActiveAcknowledged` | switch the active LLM profile (`SP/frontend-domain-api.ts:329-339`) | `generation` |
| `ctx.chats.listRecent / listRecentGrouped / listForCharacter / getMessages` | chat lookups (`SP/frontend-domain-api.ts:350-386`) | free |
| `ctx.chats.update/delete`, `ctx.chats.updateMessage` | chat + message writes (`SP/frontend-domain-api.ts:388-399`, `SP/loader.ts:2130-2141`) | `chats` |
| `ctx.messages.getLatestMessageId/listMessageIds/getContent/getRecent` | active-chat messages from the store (`SP/loader.ts:2092-2120`, `SP/frontend-domain-api.ts:426-439`) | free |
| `ctx.characters.get(id)` | one character by id (`SP/loader.ts:2122-2129`) - **no list/search** | free |
| `ctx.getActiveChat()` | `{chatId, characterId}` | free |
| `ctx.events.on(name)` | any host WebSocket event (e.g. `GENERATION_STARTED/ENDED`) + `spindle:*` window events; no permission check in the frontend (`SP/loader.ts:1493-1523`) | free |
| `ctx.ui.events.get/onDrawer/Settings/Modal/Keyboard...` | UI state observers (`SP/ui-events-helper.ts:45-59`) | free |
| `ctx.ui.registerInputBarAction`, `ctx.ui.mount('chat_input_tools_left'\|...)`, `createFloatWidget`, `requestDockPanel`, `mountApp`, `showModal`, `showConfirm` | where to put the mic button / listening bubble / confirm dialogs | float/dock: `ui_panels`; mountApp: `app_manipulation`; others free (`SP/frontend-authority-map.ts:196-199`) |
| `ctx.theme.catalog.listComponents()` | `[data-component="X"]` selectors of ~31 themable host components (`SP/theme-authoring.ts:339-349`) - the most stable public selector list for a DOM fallback | free |
| `ctx.dom.query/queryAll` | **scoped to the extension's own DOM**, not the host page (`types:dom.ts:81-85`) | free |
| `ctx.settings.get/set` | the extension's own settings namespace; `ctx.settings.core` = read-only audited keys | free |

Backend (`spindle.*`, worker) adds entity CRUD that the frontend `ctx` does not have; the frontend talks to its backend with
`ctx.sendToBackend` / `ctx.onBackendMessage`. Relevant backend members and permissions (`types:spindle-api.ts`):
`characters.list/get` (`characters`, max 200/page, no search; `src/spindle/worker-host-content-api.ts:224-248`),
`personas.list/get/getActive/switchActive` (`personas`, `:1415-1429`), `chats.list/get/getActive` (`chats`; **no create**, `:1064-1073`),
`presets.list/get/getActive` (`presets`; **no set-active**, `:1085-1108`), `chat.appendMessage/updateMessage/deleteMessage` (`chat_mutation`, `:659-742`),
`decisions.listConnections` (`decisions`, `types:decisions.ts:78`), `imageGen.listConnections` (`image_gen`, `:952`),
`images.readBinary/get` (`images`), `theme.apply/applyPalette/getCurrent` (free overlay, `:2050-2111`),
`ui.openDrawerTab/openSettings/openCommandPalette` (free, `:1954-1993`), `toast.*` (free).

**Types vs. host mismatches** (feature-detect, do not trust the d.ts): the types declare `ctx.registerMessageAction`
(`types:dom.ts:1494`), `ctx.messages.get/list/update/delete` (`:1456-1459`), `ctx.chats.list/get/getActive` (`:1468-1470`) and
`ctx.connections.get` (`:1182-1186`); the staging loader does not provide them (no such members in `SP/loader.ts` or
`SP/frontend-domain-api.ts`). `ctx.connections.list()` is synchronous in the host but typed as a Promise.

---

## 2. The host surface catalog (verified by running)

**API:** `ctx.host.surfaces` (`SP/loader.ts:1429-1434`, `SP/host-surfaces.ts:298-421`, `types:dom.ts:1116-1125`):
- `list(kinds?)` returns `{kind, id, label, description?, keywords?, scope?, role?, owner?, invocable?}[]`,
  role-filtered for the current user, live (includes enabled extensions' drawer tabs, settings tabs, palette commands, input-bar actions).
- `subscribe(cb)` fires on store changes. `invoke({kind, id}, params?)` runs it.
- `invoke` checks: authority row exists -> surface is in the current catalog -> `invocable !== false` -> permission granted ->
  role for settings tabs (`SP/host-surfaces.ts:401-419`), then one shared switch `applyHostAction` (`SP/host-actions.ts:123-173`).
- Params: `drawer_tab` `{target?}`; `settings_tab` `{anchorId?}`; `route` `{chatId}` or `{id}` (id must match
  `/^[A-Za-z0-9_-]{1,64}$/`, `SP/host-actions.ts:60,96-116`); `modal` `{id, entryId?}`; `command`, `input_bar_action`,
  `ext_command`: **no params allowed** (`only(params)`).
- Not enforced: `scope` (`chat-idle` etc.) is metadata only; `invoke` does not check it. Lumi Voice must check context itself
  (`ctx.state.get('chat.active')`, generation events).
- `settings_tab` `anchorId` is validated but dropped: the default runtime calls `openSettings(id)` without it
  (`SP/host-surfaces.ts:245`). Section anchors exist in the registry (`frontend/src/lib/settings-tab-registry.tsx:368-370`), so this looks like a small host bug.
- Extension-owned entries: `input_bar_action` / `ext_command` of *another* extension need `app_manipulation`; own ones are free
  (`SP/frontend-authority-map.ts:104-107`). Extension drawer/settings tabs are free.

Full machine-readable list with keywords: `spec/surface-catalog.json`. Summary (core host, no extensions enabled):

### 2.1 Drawer tabs (`kind: drawer_tab`, all free) - 23
| id | label | description | keywords |
|---|---|---|---|
| `profile` | Profile | View and edit the active character | character, avatar, info, edit, card, description, bio, greeting, first message |
| `presets` | Reasoning | Configure reasoning, chain-of-thought, and prompt behavior | reasoning, cot, chain of thought, thinking, reasoning effort, api reasoning, prompt bias, start reply with, prefix, suffix |
| `loom` | Preset | Configure narrative structure and story beats | preset, presets, narrative, story, lore, structure, beats, loom, pacing, plot, sovereign hand, director |
| `weaver` | Weaver | Craft a character from your idea | weaver, dream, character, create, ai |
| `connections` | Connections | Manage API connections and providers | api, provider, key, openai, anthropic, model, endpoint, google, vertex, claude, gemini, openrouter, deepseek, url, secret |
| `browser` | Pack Browser | Browse and manage content packs | packs, content, download, browse, browser, install, marketplace, library, search |
| `characters` | Characters | Browse and manage your character cards | character, list, import, card, browse, export, png, charx, gallery, switch, select |
| `personas` | Personas | Manage your user personas | persona, identity, user, avatar, name, sender, you, addons |
| `multiplayer` | Multiplayer | Host or join a room and chat with bots alongside friends | multiplayer, room, party, friends, group, coop, co-op, join, host, invite, turn |
| `lorebook` | Lorebook | Edit world book and lorebook entries | lorebook, world, lore, book, entries, worldbook, world info, wi, keywords, triggers, knowledge |
| `cortex` | Memory Cortex | View and manage memory cortex entries | memory, cortex, embeddings, recall, brain, entities, relationships, salience, vector, long term, ltcm, facts |
| `databank` | Databank | Upload and manage reference documents for AI context | databank, knowledge, documents, upload, files, bank, reference, data, rag |
| `create` | Creator Workshop | Create and edit Lumia items and Loom presets | create, workshop, editor, build, new, lumia, loom, author, write, draft, custom |
| `prompt` | Composition | Pick Lumia and Loom content, Sovereign Hand, and context filters | composition, compose, lumia, loom, sovereign hand, context filters, narrative, selection, modes |
| `council` | Council | Configure the Lumia Council and tool functions | council, tools, agents, lumia, functions, tool use, sidecar, function calling, ooc, feedback |
| `summary` | Summary | Configure context summarization and truncation | summary, context, truncation, compress, summarize, shorten, overflow, window, limit |
| `worldinfo` | World Info | View currently activated world info entries | world info, activation, lorebook, active, entries, triggered, wi, matched, fired |
| `imagegen` | Image Generation | Configure and control AI scene generation | image, generation, scene, art, picture, ai, background, novelai, nai, dalle, illustration |
| `wallpaper` | Wallpaper | Set global or per-chat background wallpapers | wallpaper, background, backdrop, image, video, animated, mp4, webm, gif, scenery, chat background |
| `regex` | Regex Scripts | Create and manage regex find/replace scripts | regex, find, replace, script, transform, filter, pattern, substitution, text, output, display, rewrite, format |
| `branches` | Branch Tree | View and navigate the chat branch history | branch, fork, history, tree, navigate, alternate, swipe, undo, timeline, rewind, path |
| `theme` | Theme | Customize colors, accent, and visual style | theme, colors, accent, appearance, dark, light, glass, radius, font, css, style, customize, ui, mode |
| `spindle` | Extensions | Manage Spindle extensions | extensions, spindle, plugins, addons, install, manage, enable, disable, uninstall, github |

### 2.2 Settings tabs (`kind: settings_tab`, all free; 5 are admin/owner only) - 24
(`productivity` appears only when the Lumiverse Suite extension is enabled, `settings-tab-registry.tsx:360`.)

| id | label | description | visible to | keywords |
|---|---|---|---|---|
| `account` | Account Settings | Manage your account details and password | all | account, profile, password, credentials, security, me, request, history, raw, json, generation |
| `display` | Display & Layout | Panel width, sidebar position, and layout options | all | display, layout, sidebar, drawer, width, panel, position, modal, chat heads, long messages, read more, pinch, zoom |
| `chat` | Chat Behavior | Message display mode, send key, and chat options | all | chat, behavior, enter to send, bubble, minimal, immersive, streaming, message |
| `extensions` | Extension Settings | Manage Spindle extension configuration | all | extensions, spindle, plugins, addons, settings |
| `guided` | Guided Generation | Configure guided generation sequences and prompt biases | all | guided, generation, sequences, bias, prompt, persistent |
| `quickReplies` | Quick Replies | Manage quick reply sets and message shortcuts | all | quick replies, shortcuts, messages, macros, quick |
| `extensionPools` | Extension Pools | Configure extension resource pool limits | all | extension, pools, resources, limits, storage |
| `webSearch` | Web Search | Configure SearXNG, Exa, or Tavily web search for council tools | all | web search, searxng, exa, search, browse, internet, web, council tool |
| `embeddings` | Embeddings | Configure embedding models and vector storage | all | embeddings, vectors, semantic, search, similarity, database, memory |
| `memoryCortex` | Memory Cortex Settings | Configure memory cortex extraction and salience | all | memory, cortex, entities, relations, salience, extraction, brain, recall |
| `notifications` | Notifications | Configure notification preferences and alerts | all | notifications, alerts, sounds, push, desktop, bell |
| `voice` | Voice & Speech | Text-to-speech, speech-to-text, and voice settings | all | voice, speech, tts, stt, text to speech, speech to text, microphone, audio, speak, whisper |
| `mcpServers` | MCP Servers | Connect to external MCP tool servers for function calling | all | mcp, tools, servers, model context protocol, function calling, external |
| `advanced` | Advanced Settings | Advanced configuration and debug options | all | advanced, debug, config, technical, expert, context filters, reasoning |
| `lumihub` | LumiHub | LumiHub cloud sync and sharing settings | all | lumihub, cloud, sync, sharing, online, hub |
| `illarin` | Illarin | Illarin asset delivery and account linking | all | illarin, cloud, sync, assets, online, link |
| `dataPortability` | Data Portability | Export your data or import a previously exported archive | all | data, portability, export, import, backup, restore, archive, lvbak, migrate |
| `diagnostics` | Diagnostics | System health, performance metrics, and debug info | all | diagnostics, health, performance, debug, info, system, status, metrics |
| `streamDeck` | Stream Deck Integration | Create and revoke restricted tokens for the Stream Deck plugin | all | stream deck, elgato, hardware, shortcut, integration token |
| `ssoProviders` | Single Sign-On | Configure owner-managed OpenID Connect sign-in providers | admin/owner | sso, single sign-on, openid, oidc, oauth, authelia, authentik, keycloak, identity provider |
| `operator` | Operator Panel | Server management, updates, and restart controls | admin/owner | operator, server, restart, update, git, branch, logs, admin, image processing, image optimization, thumbnails, sharp |
| `tokenizers` | Tokenizer Manager | Manage and test tokenizer configurations | admin/owner | tokenizer, tokens, count, encoding, tiktoken, bpe |
| `users` | User Management | Manage user accounts, roles, and permissions | admin/owner | users, accounts, roles, permissions, admin, management |
| `migration` | Migration | Import data from SillyTavern and other sources | admin/owner | migration, import, sillytavern, transfer, data, convert |

### 2.3 Commands (`kind: command`) - 65
- 16 action commands (table below; source `frontend/src/lib/commands.ts:37-398`).
- `panel-<id>` for each of the 23 drawer tabs plus `panel-ooc` (OOC) and `panel-feedback` (Council Feedback), which open the
  Council tab on that view (`frontend/src/lib/drawer-tab-registry.tsx:483-512,558-572`). All free.
- `settings-<id>` for each visible settings tab (same label/description/keywords as 2.2). All free.

| id | label | description | scope | permission | keywords |
|---|---|---|---|---|---|
| `action-regenerate` | Regenerate Response | Delete the last AI reply and generate a new one | chat-idle | generation | regenerate, retry, redo, reroll, response |
| `action-continue` | Continue Generation | Prompt the AI to continue its last response | chat-idle | generation | continue, extend, more, nudge, generation |
| `action-new-chat` | New Chat | Go to the home screen to start a new conversation | global | free | new, chat, start, home, begin, create |
| `action-character-browser` | Browse Characters | Open the full character library | global | free | characters, library, browse, list, cards |
| `action-import-character` | Import Character | Upload a character card (.png, .charx, .jpg, .json) | global | characters | import, upload, card, character, file |
| `action-new-chat-same-character` | New Chat (Same Character) | Start a fresh conversation with the current character | chat | free | new, chat, same, character, fresh, restart |
| `action-fork-chat` | Fork Chat | Branch the current chat at the latest message | chat-idle | chats | fork, branch, split, alternate, copy, diverge |
| `action-manage-chats` | Manage Chats | Open the chat manager for the current character | chat | free | manage, chats, history, list, browse |
| `action-copy-last-message` | Copy Last Message | Copy the most recent message to clipboard | chat | free | copy, clipboard, last, message, response |
| `action-delete-last-message` | Delete Last Message | Remove the most recent message from this chat | chat-idle | chats | delete, remove, last, message, undo |
| `action-toggle-hidden-last` | Toggle Hide Last Message | Show or hide the last message from AI context | chat-idle | chats | hide, hidden, toggle, context, message, exclude |
| `action-dry-run` | Preview Prompt | Dry-run to see the assembled prompt and token count | chat-idle | generation | dry run, preview, prompt, tokens, assembly, debug |
| `action-edit-character` | Edit Character | Open the character editor for the current character | character | free | edit, character, modify, update, profile |
| `action-duplicate-character` | Duplicate Character | Create a copy of the current character | character | characters | duplicate, clone, copy, character |
| `action-toggle-portrait` | Toggle Portrait Panel | Show or hide the character portrait sidebar | chat | free | portrait, panel, sidebar, toggle, character, image |
| `action-delete-chat` | Delete Chat | Permanently delete this conversation | chat | chats | delete, remove, destroy, chat, conversation |

Notes on action commands (read in code):
- `action-regenerate` stages a **new swipe** of the last assistant message (generation type `regenerate` is handled like `swipe`,
  `src/services/generate.service.ts:1648-1660`); the description "Delete the last AI reply" is misleading.
  So "swipe right / new reply" = `action-regenerate`.
- `action-delete-last-message` deletes immediately, **no host confirmation** (`commands.ts:246-257`). `action-delete-chat` and
  `action-fork-chat` open a host confirm modal (`commands.ts:176-194,382-396`).
- `action-import-character` opens a file picker via `input.click()` (`commands.ts:127-143`); a browser blocks that without a user
  gesture, so it will likely fail from voice (not tested).
- `action-copy-last-message` writes the clipboard; may also need focus/user activation (not tested).

### 2.4 Routes and modals
| kind | id | label | description | scope | permission |
|---|---|---|---|---|---|
| route | `/` | Home | Open the home screen | global | free |
| route | `/chat/:chatId` | Chat | Open a chat by id | chat | free |
| route | `/characters` | Characters | Open the character library | global | free |
| route | `/characters/:id` | Character | Open a character profile | character | free |
| modal | `character_editor` | Character editor | Open the character editor | character | characters |
| modal | `world_book_editor` | World book editor | Open a world book editor | global | world_books |

Backend twin: `spindle.ui.getDrawerTabs/getSettingsTabs/openDrawerTab/openSettings/closeDrawer/openCommandPalette` (free) cover only
drawers, settings and the palette (`src/spindle/worker-runtime.ts:4410-4430`).

---

## 3. Entity actions voice needs

Legend: **AVAILABLE** (exact API + permission), **PARTIAL** (works with a caveat), **GAP** (+ smallest host change).
"DOM fallback" = possible because code runs in the main document; not a contract.

| action | status | how / smallest host change |
|---|---|---|
| Open a character's page | **AVAILABLE** | `surfaces.invoke({kind:'route', id:'/characters/:id'}, {id})`, free. Editor modal: `{kind:'modal', id:'character_editor'}, {id}` needs `characters`. |
| Open a chat with a character (latest chat) | **AVAILABLE** | `ctx.chats.listForCharacter(characterId)` (free) -> newest -> `invoke({kind:'route', id:'/chat/:chatId'}, {chatId})` (free). |
| Start a **new** chat with a character | **GAP** | No create-chat API in frontend `ctx` or backend `spindle.chats` (`types:spindle-api.ts:1064-1073`; `worker-host.ts` has no `chats_create`). Only `action-new-chat-same-character` exists, for the *current* character. Smallest change: a parameterized host action `character_chat` `{characterId, mode:'latest'\|'new'}` that reuses `openChat` / `startNewChat` in `frontend/src/hooks/useCharacterBrowser.ts:660-782` (keeps the greeting picker), permission `chats`. |
| Open a recent chat | **AVAILABLE** | `ctx.chats.listRecent({search, limit})` or `listRecentGrouped` (free, server-side search) -> route `/chat/:chatId`. |
| Switch active **LLM** connection profile | **AVAILABLE** | `ctx.connections.setActive(id)` or `setActiveAcknowledged(id)`, `generation` (`SP/frontend-domain-api.ts:329-339`). List: `ctx.connections.list()` (free). |
| Switch STT / TTS / embedding / decision / image profile (user default) | **GAP** | No setter for any of these. Active STT/TTS live in the `voiceSettings` setting (`frontend/src/store/slices/settings.ts:809-811`), not in the core-read allowlist. Lumi Voice does not need to *change* these defaults (it picks its own per kind and passes `connectionId`); a "switch the TTS voice" command would need `ctx.connections.setActive(id, {kind})`. |
| Switch persona | **AVAILABLE (backend)** | `spindle.personas.switchActive(personaId)`, `personas` (`src/spindle/worker-host-content-api.ts:2216-2237`). It writes setting `activePersonaId`; the open page reloads settings on `SETTINGS_UPDATED` (`frontend/src/ws/useWebSocket.ts:1435-1440`) **unless the tab has unsaved local settings** (`frontend/src/store/slices/settings.ts:614-628`). Read active: `ctx.state.get('persona.activeId')` (free). Not tested live; per-chat persona binding was not checked. |
| Apply a theme | **GAP** | Built-in theme presets (`frontend/src/theme/presets.ts:3-86`, 9 ids) and the user's saved themes (`savedThemes` setting, `applySavedTheme` `frontend/src/store/slices/settings.ts:1181-1199`) have no extension API. `spindle.theme.apply/applyPalette` only adds an extension overlay; `ctx.theme.packs.installDraft({apply:true})` installs a new pack. Smallest change: `ctx.theme.listThemes()` -> `{id, name, kind:'preset'\|'saved', mode}[]` + `ctx.theme.applyTheme(id)` gated by `app_manipulation`. Current theme readable: `ctx.state.get('setting:theme')`. |
| Switch preset | **GAP** | Active preset = setting `activeLoomPresetId` via store `setActiveLoomPreset` (`frontend/src/store/slices/presets.ts:18-20`); no extension setter. List: `spindle.presets.list()` (`presets`); read active: `ctx.state.get('loom.activePresetId')` (free). Smallest change: `ctx.presets.setActive(id\|null)` (frontend, calls the store action) gated by `presets`. |
| Send a message | **PARTIAL** | Backend `spindle.chat.appendMessage(chatId, {role:'user', content}, {triggerGeneration:true})` needs `chat_mutation` + `generation` (`src/spindle/worker-host.ts:3913-3993`). Caveats: the message name is the literal `"User"` (not the persona, `:3944-3958`), no attachments, no group-chat targeting/queue/regex-selection logic of the composer, and the open page must pick up the new message via events. For dictation the right path is the composer (row below). |
| Regenerate | **AVAILABLE** | `invoke({kind:'command', id:'action-regenerate'})`, `generation`. Uses the active profile/persona/preset. Check "not generating" first. |
| Swipe left / right (existing swipes) | **AVAILABLE (backend)** | `spindle.chat.updateMessage(chatId, msgId, {swipe_id: n})`, `chat_mutation`; emits `MESSAGE_EDITED` + `SWIPE_EDITED` (`src/services/chats.service.ts:2791-2794`). Swipe right past the last swipe = `action-regenerate`. No frontend command; a host `action-swipe-left/right` command wrapping `executeSwipe` (`frontend/src/hooks/useSwipeAction.ts:145-201`) would be the clean fix. DOM fallback: buttons in `[data-component="SwipeControls"]` (`frontend/src/components/chat/SwipeControls.tsx:53-76`). |
| Continue | **AVAILABLE** | `invoke({kind:'command', id:'action-continue'})`, `generation`. |
| Stop generation | **GAP** | No frontend or backend extension API (backend `generate` has no stop; `types:spindle-api.ts:474-558`). Host does it in `InputArea.handleStop` -> `generateApi.stop(generationId, chatId)` (`frontend/src/components/chat/InputArea.tsx:2499-2515`). Smallest change: host command `action-stop-generation` (free or `generation`) calling the same code. DOM fallback: the stop button that replaces Send while generating (`InputArea.tsx:4505-4516`; label is localized). |
| Edit last message (destructive) | **AVAILABLE** | `ctx.chats.updateMessage(chatId, ctx.messages.getLatestMessageId(), {content})`, `chats`; updates the store (`SP/loader.ts:2130-2141`). Backend twin `spindle.chat.updateMessage` (`chat_mutation`). Lumi Voice must confirm. |
| Delete last message (destructive) | **AVAILABLE** | `invoke({kind:'command', id:'action-delete-last-message'})`, `chats` - **no host confirm**, Lumi Voice must confirm first. Backend twin `spindle.chat.deleteMessage` (`chat_mutation`). |
| Put text into the composer (dictation) | **GAP** | Composer text is React local state `const [text, setText] = useState('')` (`InputArea.tsx:299`); no store field, event or API exposes it. DOM fallback: `textarea[name="chat-message"]` (`InputArea.tsx:4485-4502`) - set the value with the native `HTMLTextAreaElement` value setter and dispatch a bubbling `input` event so React's `onChange` (`handleInput`, `:2987-2989`) picks it up (standard React trick; **not tested here**). Smallest change: `ctx.composer` - see GAP 1. |
| Read composer text | **GAP** | Same; DOM fallback reads `textarea[name="chat-message"].value`. |
| TTS play / stop | **GAP** | No extension TTS API at all (only `registerTtsEngine` for providers). Host playback lives in `frontend/src/lib/ttsAudio.ts` (`speak`, `stop`, `isSpeaking`, `:295-492`) and `ttsMessagePlayback.ts`, unreachable from an extension. DOM fallback: per-message play/stop button in `[data-component="BubbleActions"]` (localized label, `frontend/src/components/chat/BubbleActions.tsx:59-68`). |

---

## 4. Data for resolving spoken names

| entity | best source | fields useful for matching | permission |
|---|---|---|---|
| Characters (all) | backend `spindle.characters.list({limit<=200, offset})` (page through) | `name, description, tags, creator, image_id` (`types:api.ts:1274-1298`) | `characters` |
| Characters (recent, cheap) | `ctx.chats.listRecentGrouped()` | `character_name, character_image_id, group_name, latest_chat_id` (`types:dom.ts:1237-1251`) | free |
| One character | `ctx.characters.get(id)` | full card | free |
| Personas | backend `spindle.personas.list()` | `name, title, description, image_id, is_default` (`types:api.ts:2200-2212`) | `personas` |
| LLM profiles | `ctx.connections.list()` / `ctx.state.get('connections.profiles')` | `name, provider, model` | free |
| Decision profiles | backend `spindle.decisions.listConnections()` | `name, provider, model, is_default` | `decisions` |
| Image-gen profiles | backend `spindle.imageGen.listConnections()` | `name, provider, model, is_default` (`types:api.ts:763-775`) | `image_gen` |
| STT / TTS / embedding profiles | **GAP** - no extension list API (REST `/stt-connections`, `/tts-connections` exist, `frontend/src/api/stt-connections.ts:14`, `tts-connections.ts:19`) | - | - |
| Themes | **GAP** for the list (presets + saved); current theme: `ctx.state.get('setting:theme')` or `spindle.theme.getCurrent()` (`id, name, mode, accent`) | - | free |
| Presets | backend `spindle.presets.list()`; active: `ctx.state.get('loom.activePresetId')` | `name, engine, provider` (`types:api.ts:1606-1618`) | `presets` |
| Chats | `ctx.chats.listRecent({search})` (server-side search), `listForCharacter(id)` | `name, character_name, last_message_preview, updated_at, message_count` (`types:dom.ts:1219-1231`) | free |
| Drawer/settings/commands | `ctx.host.surfaces.list()` | `label, description, keywords` | free |

**Avatars as Decision images.** `CharacterDTO.image_id` / `PersonaDTO.image_id` can go to Jev as `assets: {ref: {image_id}}`, which
needs the `images` permission and host capability `decision-images-v1` (types 0.6.51+, from the earlier decisions audit). TypeSafe rejects
images with a side under 280 px, so small avatars must be read (`spindle.images.readBinary`, `images`) and padded/upscaled into
`data_base64` (not re-verified in this audit).

---

## 5. UI fallback: screenshot + click

**`screen_capture` does not capture the Lumiverse page for the extension.** It is the desktop-client OS capture
(`developer-docs/docs/getting-started/desktop-capture.md`; `src/spindle/worker-host-desktop-capture-api.ts:76-108`):
- backend only (`spindle.desktop.capture.request`), needs `screen_capture` + `generation`, privileged, never auto-granted;
- needs the native desktop client with capture enabled in its tray (macOS 14+/Windows 10 1903+; none on Linux, none in a browser);
- **every request opens the OS source picker** and the user must pick a window/display (no silent capture, no remembered source);
- the extension gets an opaque `assetId`, **never pixels**; the asset can only be sent inside `spindle.generate.raw` to one LLM
  connection of provider google / google_vertex / openai / anthropic / openrouter (`:67-74`, broker `resolveMessages`
  `src/spindle/desktop-capture-broker.ts:302+`). It cannot go to Jev (Decisions need `data_base64` or a stored `image_id`).
So the planned "screenshot -> Jev Box -> click" fallback is **blocked** with today's APIs.

Other routes, all unverified:
- `navigator.mediaDevices.getDisplayMedia()` from the main document is not blocked by a host policy (no Permissions-Policy header;
  only sandbox frames deny `display-capture`), but browsers show a picker and normally require a user gesture; a voice command has none.
- Rasterizing the DOM in-page (html2canvas-style) is possible in the main realm but heavy and inaccurate (backdrop filters, iframes).

**Click / focus.** No `ctx` API clicks host UI; `ctx.dom.query` is scoped to extension-owned DOM. Because code runs in the main
document, `document.elementFromPoint(x, y)` / `document.querySelector(sel)` + `.focus()` / `.click()` work technically (React handles
dispatched bubbling `click` events). Stable anchors: `[data-component="..."]` from `ctx.theme.catalog.listComponents()`,
`data-spindle-mount` slots, `aria-label`s (localized). What blocks it: no contract (selectors can change), localized labels,
CSS-module class names, virtualized chat list (only visible messages have DOM), and no screenshot route for Jev.
**Suggestion:** for the experimental fallback, build the candidate list from the DOM (visible `button`/`[role=button]`/`a` with
`aria-label`/`title`/text + bounding rect) and ask Jev a text `choice` question, instead of a screenshot + `box` question.

---

## 6. Ranked GAPs for "control most of Lumiverse by voice"

1. **Composer API** (dictation is half the product). Proposed `ctx.composer`:
   `getText(): string`, `setText(text)`, `insertText(text, {at:'caret'|'end'})`, `focus()`, `onChange(cb)`, and
   `send(): Promise<void>` that runs the real `handleSend` (persona name, attachments, group targeting, queue).
   Read/set/insert free (the user still sees and sends the draft); `send` gated by `generation`. Implementation: InputArea registers
   a handle in a small registry while mounted (it owns `text` state, `InputArea.tsx:299`).
2. **Generation-control commands** in `COMMANDS` + authority rows: `action-stop-generation` (wrap `generateApi.stop`),
   `action-swipe-left`, `action-swipe-right` (wrap `executeSwipe`, `useSwipeAction.ts:145`), optionally `action-impersonate`.
   Tiny change: 3-4 entries in `frontend/src/lib/commands.ts` + rows in `SP/frontend-authority-map.ts:69-86`; they appear in
   the palette too, so it is a user-facing feature, not an extension-only hook.
3. **Parameterized entity actions** through the same `invoke`: today `command` forbids params (`SP/host-actions.ts:146-148`).
   Add a few actions with validated params: `switch_persona {personaId}` (`personas`), `switch_preset {presetId}` (`presets`),
   `apply_theme {themeId}` (`app_manipulation`), `character_chat {characterId, mode:'latest'|'new'}` (`chats`).
   They also fix the "start new chat with X" gap. Each reuses an existing store action/hook, so the host change is mostly wiring.
4. **Connection profiles of every kind**: `ctx.connections.list({kind})` / `getActive(kind)` for `llm|stt|tts|embedding|decision|image`
   (credential-free projections, free like today's LLM list). Needed to resolve "use my ElevenLabs voice" and to fill Lumi Voice's
   own per-kind pickers (STT/TTS/embedding lists have no API today).
5. **TTS API**: `ctx.tts.speak({text} | {messageId}, {connectionId?})`, `stop()`, `isSpeaking()` (frontend, reusing `ttsAudio.ts`), gated
   by `media`. Needed for voice replies and "read that again / stop reading".
6. **Embedding API** (already known): `spindle.embeddings.embed(texts, {connectionId})` for large-list narrowing.
7. **Theme list/apply** (if not done via 3): `ctx.theme.listThemes()` + `applyTheme(id)`.
8. **Frontend character/persona search**: `ctx.characters.list({search, limit})` and a `personas.list` selector, so the frontend can
   resolve names without a backend round trip and without the 200-per-page loop.
9. Small host fixes found on the way: `settings_tab` `anchorId` is dropped (`SP/host-surfaces.ts:245`); types declare members the host
   lacks (section 1); `action-regenerate` description is wrong. Optional: enforce `scope` in `invoke` or expose `invocableNow`.
10. Screenshot for Jev Box: lowest priority and hardest to get through security review (it would expose page pixels to an extension);
    the DOM-candidate approach in section 5 needs no host change.

**What already works without any host PR:** all 23 drawer tabs, 24 settings tabs, 65 palette commands, home/characters/chat routes,
open character page, open latest/recent chat, regenerate, continue, LLM profile switch, persona switch (backend), edit/delete last
message, existing-swipe navigation (backend), STT via `ctx.stt`, and every extension command/drawer tab another extension registers
(cross-extension invoke needs `app_manipulation`).

Permission set for Lumi Voice v0 (from the above): `media` (STT), `decisions` (Jev), `generation` (regenerate/continue/LLM switch),
`chats` (edit/delete), `characters`, `personas`, `presets` (lookups), `images` (avatars to Jev), `chat_mutation` (swipes), `ui_panels`
(float widget for the bubble), `app_manipulation` (only if it invokes other extensions' commands).

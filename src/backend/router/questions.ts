import type { DecisionDescription, DecisionImageAsset, DecisionQuestion, DecisionState } from "lumiverse-spindle-types";
import type { ActionCandidate, ArgKind, EntityOption, PendingAsk, RouteRequest } from "../../shared/protocol";
import type { Services } from "../services/types";

export const NO_ACTION = "none";
export const UNCLEAR = "unclear";
export const NO_PENDING = "none of these";
export const IMAGE_LIMIT = 8;
/** Best-matching entity names shown with an action that needs one, so Jev knows what a name refers to. */
const EXAMPLE_NAMES = 8;
const IMAGE_MIN = 280;
const IMAGE_MAX = 1568;

const LOOKS =
  /\b(hair|haired|eyes|eyed|wearing|wears|dress|glasses|blonde?|brunette|redhead|outfit|tattoo|skin|ears|horns?|tail|uniform|beard|bearded|mask|masked|hat|hood|hooded|helmet|scar|freckles|looks|looking|(one|girl|guy|woman|man|boy) (with|in|who|wearing))\b/i;

const ARG_NOUN: Record<ArgKind, string> = {
  character: "character",
  persona: "persona (the user's own identity in chats)",
  preset: "preset",
  theme: "theme",
  llm_profile: "LLM connection profile (an AI model setup, often named after the model or provider)",
  chat: "recent chat",
};

/** Extra matching words for Lumi's own actions (LUMI_ACTIONS has none). */
const LUMI_KEYWORDS: Record<string, string> = {
  "lumi:character_open": "open, show, profile, card, page",
  "lumi:character_chat_latest": "chat with, talk to, go back to, continue the chat with",
  "lumi:character_chat_new": "new chat, fresh chat, start a chat, start over with",
  "lumi:chat_open": "open chat, recent chat, go to the chat, that chat",
  "lumi:persona_switch": "persona, be, play as, I am, switch me to",
  "lumi:preset_switch": "preset, use preset, switch preset",
  "lumi:theme_apply": "theme, colors, look, dark, light, use theme",
  "lumi:llm_switch": "model, AI, connection, use, switch to, provider",
  "lumi:swipe_left": "swipe left, swipe back, previous reply, last swipe, go back one swipe",
  "lumi:swipe_right": "swipe right, next reply, another reply, new swipe",
  "lumi:stop": "stop, halt, cancel, enough, wait stop",
  "lumi:close": "close, close Lumi, go away, dismiss, that's all, goodbye",
  "lumi:stop_listening": "stop listening, mute, turn off the mic, stop the microphone, go to sleep",
  "lumi:draft_send": "send it, send, submit, post it, go ahead",
  "lumi:draft_rewrite": "rewrite, rephrase, improve, polish, make it better",
  "lumi:draft_clear": "clear, erase, delete the draft, scrap it, start over",
  "lumi:draft_read": "read it back, read aloud, what did I write",
  "lumi:undo": "undo, revert, put it back, change it back",
  "lumi:screen_control": "click, press, tap, button, toggle, the thing on screen",
};

const KIND_HINT: Record<string, string> = {
  drawer_tab: "opens a side panel",
  settings_tab: "opens a settings page",
  command: "runs a command",
  route: "goes to a page",
  modal: "opens a dialog",
};

export interface Ranked {
  item: EntityOption;
  score: number;
}

export interface DecisionPlan {
  input: { state: DecisionState; questions: Record<string, DecisionQuestion>; assets?: Record<string, DecisionImageAsset> };
  actions: Map<string, ActionCandidate>;
  args: Partial<Record<ArgKind, Map<string, EntityOption>>>;
  pending?: Map<string, PendingAsk["options"][number]>;
}

/** Unique option keys from labels; `reserved` is the safe first option's key. */
function keyed<T>(items: readonly T[], label: (item: T) => string, reserved: string): Map<string, T> {
  const map = new Map<string, T>();
  for (const item of items) {
    const base = label(item).replace(/\s+/g, " ").trim().slice(0, 80) || "option";
    let key = base;
    for (let n = 2; key.toLowerCase() === reserved || map.has(key); n++) key = `${base} (${n})`;
    map.set(key, item);
  }
  return map;
}

function actionCriterion(c: ActionCandidate, entities: Partial<Record<ArgKind, Ranked[]>>) {
  const kind = c.id.startsWith("surface:") ? c.id.split(":")[1]! : "";
  const keywords = c.keywords?.length ? c.keywords.slice(0, 12).join(", ") : LUMI_KEYWORDS[c.id];
  const examples = c.arg ? (entities[c.arg] ?? []).slice(0, EXAMPLE_NAMES).map((r) => r.item.name) : [];
  return {
    does: c.description ?? c.label,
    ...(KIND_HINT[kind] ? { kind: KIND_HINT[kind] } : {}),
    ...(keywords ? { keywords } : {}),
    ...(c.arg ? { needs: `a ${ARG_NOUN[c.arg]}${examples.length ? `, one of: ${examples.join(", ")}` : ""}` } : {}),
  };
}

/**
 * True when the utterance describes a character's looks, so portraits should go to Jev.
 * A half-heard name is not enough: with many characters almost any word partly matches some name.
 */
export function wantsPortraits(utterance: string): boolean {
  return LOOKS.test(utterance);
}

async function portraitRefs(ranked: Ranked[], services: Services): Promise<Map<string, string>> {
  const refs = new Map<string, string>();
  const withImage = ranked.filter((r) => r.item.imageId).slice(0, IMAGE_LIMIT);
  const sizes = await Promise.all(withImage.map((r) => services.portraitSize(r.item.imageId!).catch(() => null)));
  withImage.forEach((r, i) => {
    const s = sizes[i];
    if (s && [s.width, s.height].every((px) => px >= IMAGE_MIN && px <= IMAGE_MAX)) refs.set(r.item.id, `lumi-portrait-${i + 1}-${r.item.imageId}`);
  });
  return refs;
}

/** The one Jev request for an utterance: intent, action, one argument choice per needed kind, multi-step noul, pending answer. */
export async function buildDecision(
  req: RouteRequest,
  candidates: ActionCandidate[],
  entities: Partial<Record<ArgKind, Ranked[]>>,
  services: Services,
): Promise<DecisionPlan> {
  const { context } = req;
  const state: Record<string, unknown> = {
    utterance: req.utterance,
    app: {
      route: context.route,
      chat_open: context.chatOpen,
      generating_reply: context.generating,
      chat_draft: context.draft ? context.draft.slice(0, 300) : "(empty)",
    },
    session_so_far: context.history.slice(-4).map((h) => `user: ${h.said} -> Lumi: ${h.did}`),
    lumi_last_said: context.lumiSaid || "(nothing yet)",
  };
  const questions: Record<string, DecisionQuestion> = {
    intent: {
      type: "choice",
      instructions:
        "The user is talking to Lumi, a voice assistant inside the Lumiverse roleplay chat app. `utterance` is what speech recognition heard (it may have errors). What is it? Use `app` and `session_so_far` for context.",
      criteria: {
        close:
          "The user is done with Lumi and ends the conversation: \"that's about it\", \"I don't need anything else\", \"thanks Lumi, bye\", \"thanks, that's all\", \"okay, thank you\", \"great, thanks\", \"bye Lumi\", \"never mind, close\". A thank-you right after Lumi finished a task (see `lumi_last_said`) is a close, even when speech recognition garbled the end (\"thanks, Lumi, but...\").",
        command:
          "The user asks Lumi to do something in the app: open or go to something, switch or apply something, start a chat, regenerate, swipe, continue, stop, send, rewrite, clear or read the draft, change a setting.",
        dictation:
          "Text the user wants typed into the chat message: roleplay prose, a character's actions or dialogue, a reply in the story, or anything after \"write\" or \"type\".",
        not_for_lumi: "Not meant for Lumi: the user talks to someone else in the room, background noise, or a meaningless fragment.",
      },
    },
  };

  const actions = keyed(candidates, (c) => c.label, NO_ACTION);
  questions.action = {
    type: "choice",
    instructions:
      "If `utterance` is a request to Lumi, which single action does the user want? Words may be misheard (\"claw\" can be Claude, \"lore book\" is Lorebook). Use `app` for context.",
    criteria: {
      [NO_ACTION]: "No listed action fits, the request is unclear, or it is not a request.",
      ...Object.fromEntries([...actions].map(([key, c]) => [key, actionCriterion(c, entities)])),
    },
  };

  const assets: Record<string, DecisionImageAsset> = {};
  const args: DecisionPlan["args"] = {};
  const neededKinds = [...new Set(candidates.flatMap((c) => (c.arg ? [c.arg] : [])))];
  for (const kind of neededKinds) {
    let ranked = entities[kind] ?? [];
    if (!ranked.length) continue;
    let portraits = new Map<string, string>();
    if (kind === "character" && services.decisionImages && wantsPortraits(req.utterance)) {
      portraits = await portraitRefs(ranked, services);
      if (portraits.size) ranked = ranked.slice(0, IMAGE_LIMIT);
    }
    const options = keyed(ranked.map((r) => r.item), (e) => e.name, UNCLEAR);
    args[kind] = options;
    const criteria: Record<string, DecisionDescription | null> = {
      [UNCLEAR]: `The user names or describes no ${kind} from this list, or it is unclear which one. A name that sounds like one in the list counts as named.`,
    };
    for (const [key, e] of options) {
      const ref = portraits.get(e.id);
      if (ref && e.imageId) assets[ref] = { image_id: e.imageId };
      criteria[key] = ref ? { name: e.name, ...(e.detail ? { about: e.detail } : {}), portrait: ref } : (e.detail ?? null);
    }
    questions[`arg_${kind}`] = {
      type: "choice",
      instructions: `Which ${ARG_NOUN[kind]} does \`utterance\` name or describe? Names may be misheard by speech recognition: pick the one that sounds closest.${portraits.size ? " Some options show the character's portrait; match descriptions of looks against it." : ""}`,
      criteria,
    };
  }

  questions.multi = {
    type: "noul",
    instructions:
      "Does `utterance` ask Lumi for two or more different app actions to be done one after another (for example \"open themes and then switch my persona to Ava\")? Describing one thing in several ways (\"open the red haired one, Seo something\") is one action.",
  };

  let pending: DecisionPlan["pending"];
  if (req.pending) {
    state.lumi_asked = req.pending.question;
    pending = keyed(req.pending.options, (o) => o.label, NO_PENDING);
    questions.pending = {
      type: "choice",
      instructions:
        "Lumi just asked the user `lumi_asked`. Is `utterance` an answer that picks one of the options? \"Yes\", \"the first one\", \"the second\" or a (misheard) name count as picks.",
      criteria: {
        [NO_PENDING]: "The user picks none of the options, says no, or says something else.",
        ...Object.fromEntries([...pending.keys()].map((key, i) => [key, `option ${i + 1}`])),
      },
    };
  }

  return { input: { state: state as DecisionState, questions, ...(Object.keys(assets).length ? { assets } : {}) }, actions, args, pending };
}

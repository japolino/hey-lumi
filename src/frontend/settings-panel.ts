import type { ConnectionKind, FrontendCtx } from "../shared/host-ext";
import type { BackendProfiles, ProfileOption } from "../shared/protocol";
import type { HeyLumiSettings } from "../shared/settings";

export interface PanelDeps {
  ctx: FrontendCtx;
  root: HTMLElement;
  settings(): HeyLumiSettings;
  save(next: HeyLumiSettings): void;
  listening(): boolean;
  toggleListening(): void;
  status(): string;
  /** Live line: which wake word detector runs, download progress. */
  wakeLine: HTMLElement;
  /** Host feature name -> available. */
  support(): Array<{ name: string; ok: boolean }>;
  backendProfiles(): Promise<BackendProfiles>;
}

async function kindProfiles(ctx: FrontendCtx, kind: ConnectionKind): Promise<ProfileOption[] | null> {
  if (!ctx.connections) return null;
  if (kind !== "llm" && !((ctx.host.capabilities?.["connection-kinds-v1"] ?? 0) >= 1)) return null;
  const rows = (await Promise.resolve(ctx.connections.list(kind === "llm" ? undefined : { kind }))) as Array<{ id: string; name: string; active?: boolean; is_default?: boolean }>;
  return Array.isArray(rows) ? rows.map((r) => ({ id: r.id, name: r.name, isDefault: !!(r.active ?? r.is_default) })) : null;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, props: Record<string, unknown> = {}, ...children: Array<Node | string>): HTMLElementTagNameMap[K] {
  const node = Object.assign(document.createElement(tag), props) as HTMLElementTagNameMap[K];
  node.append(...children);
  return node;
}

/** The "Hey Lumi!" drawer tab: start/stop, host support, profile per kind, dictation format. */
export function renderSettingsPanel(deps: PanelDeps): () => Promise<void> {
  const { root } = deps;
  root.style.cssText = "padding:12px;display:flex;flex-direction:column;gap:12px;font-size:13px";

  const update = (patch: (s: HeyLumiSettings) => void) => {
    const next = structuredClone(deps.settings());
    patch(next);
    deps.save(next);
  };

  const row = (label: string, control: HTMLElement, hint?: string) =>
    el("label", { style: "display:flex;flex-direction:column;gap:4px" }, el("span", { textContent: label }), control, ...(hint ? [el("small", { textContent: hint, style: "opacity:.7" })] : []));

  const select = (options: Array<[string, string]>, value: string, onChange: (v: string) => void, disabled = false) => {
    const s = el("select", { disabled });
    for (const [v, text] of options) s.append(el("option", { value: v, textContent: text, selected: v === value }));
    s.addEventListener("change", () => onChange(s.value));
    return s;
  };

  return async function refresh() {
    const s = deps.settings();
    const backend = await deps.backendProfiles().catch(() => ({ decision: [], embedding: null }) as BackendProfiles);
    const [stt, llm, tts] = await Promise.all([kindProfiles(deps.ctx, "stt"), kindProfiles(deps.ctx, "llm"), kindProfiles(deps.ctx, "tts")]);

    const profileSelect = (key: keyof HeyLumiSettings["profiles"], list: ProfileOption[] | null, missing: string) =>
      list
        ? row(
            key === "decision" ? "Decision (Jev)" : key === "llm" ? "LLM" : key === "stt" ? "Speech to text" : key === "tts" ? "Text to speech" : "Embedding",
            select([["", "Lumiverse default"], ...list.map((p): [string, string] => [p.id, p.isDefault ? `${p.name} (default)` : p.name])], s.profiles[key], (v) =>
              update((n) => void (n.profiles[key] = v)),
            ),
          )
        : row(key === "stt" ? "Speech to text" : key === "tts" ? "Text to speech" : "Embedding", select([["", "Lumiverse default"]], "", () => {}, true), missing);

    const decision = backend.decision.find((p) => (s.profiles.decision ? p.id === s.profiles.decision : p.isDefault));
    const decisionHint =
      decision?.model && !/jev-preview|1\.14/i.test(decision.model)
        ? [el("small", { textContent: `This profile uses ${decision.model}. Hey Lumi! is tuned for Jev 1.14 (jev-preview); matching by looks needs it.`, style: "opacity:.75" })]
        : [];

    const listenBtn = el("button", { type: "button", textContent: deps.listening() ? "Stop listening" : "Start listening" });
    listenBtn.addEventListener("click", () => {
      deps.toggleListening();
      setTimeout(() => void refresh(), 300);
    });

    const check = (label: string, value: boolean, onChange: (v: boolean) => void, disabled = false) => {
      const c = el("input", { type: "checkbox", checked: value, disabled });
      c.addEventListener("change", () => onChange(c.checked));
      return el("label", { style: "display:flex;gap:6px;align-items:center" }, c, label);
    };
    const idle = el("input", { type: "number", min: "5", max: "120", value: String(s.idleTimeoutSec), style: "width:6em" });
    idle.addEventListener("change", () => update((n) => void (n.idleTimeoutSec = Number(idle.value) || 20)));

    root.replaceChildren(
      el("div", { style: "display:flex;gap:8px;align-items:center" }, listenBtn, el("span", { textContent: deps.status() })),
      el("small", { textContent: 'Say "Hey Lumi", then a command ("open my themes") or text to write. Say "that\'s all" or press Escape to close.', style: "opacity:.75" }),
      check('Wake word "Hey Lumi"', s.wakeWord, (v) => update((n) => void (n.wakeWord = v))),
      deps.wakeLine,
      row("Close after silence (seconds)", idle),
      el("b", { textContent: "Connection profiles" }),
      profileSelect("stt", stt, "Choosing an STT profile needs a newer Lumiverse; the Voice & Speech setting is used (Whistle if it cannot transcribe audio)."),
      profileSelect("decision", backend.decision, ""),
      ...decisionHint,
      profileSelect("llm", llm, ""),
      profileSelect("embedding", backend.embedding, "Embeddings for extensions need a newer Lumiverse; names are matched by text only."),
      profileSelect("tts", tts, "Choosing a TTS profile needs a newer Lumiverse."),
      check("Speak short replies", s.voiceReplies, (v) => update((n) => void (n.voiceReplies = v)), !deps.ctx.tts),
      el("b", { textContent: "Dictation format" }),
      row("Thoughts", select([["asterisks", "*In italics*"], ["plain", "Plain"]], s.format.thought, (v) => update((n) => void (n.format.thought = v as HeyLumiSettings["format"]["thought"])))),
      row("Dialogue quotes", select([["straight", '"Straight"'], ["curly", "“Curly”"]], s.format.quotes, (v) => update((n) => void (n.format.quotes = v as HeyLumiSettings["format"]["quotes"])))),
      row("Out of character", select([["double_parens", "((OOC))"], ["brackets", "[OOC]"]], s.format.ooc, (v) => update((n) => void (n.format.ooc = v as HeyLumiSettings["format"]["ooc"])))),
      el("b", { textContent: "Lumiverse support" }),
      el("ul", { style: "margin:0;padding-left:18px" }, ...deps.support().map((f) => el("li", { textContent: `${f.ok ? "✓" : "✗"} ${f.name}` }))),
    );
  };
}

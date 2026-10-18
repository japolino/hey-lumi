import type { SessionView } from "./session";

export interface PillState {
  /** Mic state shown while no session is open. */
  mic: "off" | "starting" | "listening" | "paused" | "error";
  title: string;
}

export interface BubbleHandlers {
  onPill(): void;
  onClose(): void;
  onType(text: string): void;
}

const CSS = `
.lumi-voice{position:fixed;right:16px;bottom:96px;z-index:9995;font:13px/1.4 var(--lumiverse-font-family,system-ui,sans-serif);color:var(--lumiverse-text,#eee)}
.lumi-voice *{box-sizing:border-box}
.lumi-voice-pill{display:flex;align-items:center;gap:6px;margin-left:auto;padding:6px 10px;border-radius:999px;border:1px solid var(--lumiverse-border-light,#ffffff22);background:var(--lumiverse-bg-elevated,#222);color:inherit;cursor:pointer;font:inherit;box-shadow:0 2px 10px #0004}
.lumi-voice-dot{width:9px;height:9px;border-radius:50%;background:var(--lumiverse-text-dim,#888)}
.lumi-voice[data-mic=listening] .lumi-voice-dot{background:var(--lumiverse-primary,#8b5cf6)}
.lumi-voice[data-mic=paused] .lumi-voice-dot{background:var(--lumiverse-warning,#d97706)}
.lumi-voice[data-mic=error] .lumi-voice-dot{background:var(--lumiverse-danger,#dc2626)}
.lumi-voice[data-mic=starting] .lumi-voice-dot{opacity:.5}
.lumi-voice-panel{width:300px;padding:10px 12px;border-radius:14px;border:1px solid var(--lumiverse-border-light,#ffffff22);background:var(--lumiverse-bg-elevated,#222);box-shadow:0 6px 24px #0006}
.lumi-voice-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.lumi-voice-head b{flex:1;font-weight:600}
.lumi-voice[data-phase=listening] .lumi-voice-panel .lumi-voice-dot{background:var(--lumiverse-primary,#8b5cf6)}
.lumi-voice[data-hearing=true] .lumi-voice-panel .lumi-voice-dot{animation:lumi-voice-pulse .8s ease-in-out infinite alternate}
.lumi-voice[data-phase=thinking] .lumi-voice-panel .lumi-voice-dot{background:var(--lumiverse-warning,#d97706)}
.lumi-voice[data-phase=asking] .lumi-voice-panel .lumi-voice-dot,.lumi-voice[data-phase=confirming] .lumi-voice-panel .lumi-voice-dot{background:var(--lumiverse-success,#16a34a)}
@keyframes lumi-voice-pulse{to{transform:scale(1.5)}}
.lumi-voice-x{border:0;background:none;color:var(--lumiverse-text-muted,#aaa);cursor:pointer;font-size:16px;line-height:1;padding:2px 4px}
.lumi-voice-heard{color:var(--lumiverse-text-muted,#aaa);font-style:italic;margin:2px 0;overflow-wrap:anywhere}
.lumi-voice-said{margin:4px 0;overflow-wrap:anywhere;white-space:pre-wrap}
.lumi-voice-options{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
.lumi-voice-options button{padding:4px 10px;border-radius:8px;border:1px solid var(--lumiverse-primary-050,#8b5cf680);background:var(--lumiverse-primary-015,#8b5cf626);color:inherit;cursor:pointer;font:inherit}
.lumi-voice-type{width:100%;margin-top:6px;padding:5px 8px;border-radius:8px;border:1px solid var(--lumiverse-border-light,#ffffff22);background:var(--lumiverse-input-bg,#0003);color:inherit;font:inherit}
`;

const PHASE_TEXT: Record<SessionView["phase"], string> = {
  closed: "",
  listening: "Listening",
  thinking: "Working",
  asking: "Question",
  confirming: "Confirm",
};

/** The floating pill (mic state) and the session bubble. Own DOM on document.body, styled with host theme variables. */
export function createBubble(handlers: BubbleHandlers) {
  const style = document.createElement("style");
  style.textContent = CSS;
  const root = document.createElement("div");
  root.className = "lumi-voice";
  root.setAttribute("data-lumi-voice", "");
  root.append(style);

  const pill = document.createElement("button");
  pill.type = "button";
  pill.className = "lumi-voice-pill";
  pill.innerHTML = '<span class="lumi-voice-dot"></span><span>Lumi</span>';
  pill.addEventListener("click", handlers.onPill);

  const panel = document.createElement("div");
  panel.className = "lumi-voice-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Lumi Voice");
  const head = document.createElement("div");
  head.className = "lumi-voice-head";
  const state = document.createElement("b");
  const x = document.createElement("button");
  x.type = "button";
  x.className = "lumi-voice-x";
  x.setAttribute("aria-label", "Close Lumi");
  x.textContent = "×";
  x.addEventListener("click", handlers.onClose);
  head.append(Object.assign(document.createElement("span"), { className: "lumi-voice-dot" }), state, x);
  const heard = document.createElement("div");
  heard.className = "lumi-voice-heard";
  const said = document.createElement("div");
  said.className = "lumi-voice-said";
  said.setAttribute("aria-live", "polite");
  const opts = document.createElement("div");
  opts.className = "lumi-voice-options";
  const input = document.createElement("input");
  input.className = "lumi-voice-type";
  input.placeholder = "Or type to Lumi...";
  input.addEventListener("keydown", (e) => {
    e.stopPropagation();
    if (e.key === "Enter" && input.value.trim()) {
      handlers.onType(input.value.trim());
      input.value = "";
    }
    if (e.key === "Escape") handlers.onClose();
  });
  panel.append(head, heard, said, opts, input);
  root.append(pill);
  document.body.append(root);

  let open = false;
  const onKey = (e: KeyboardEvent) => {
    if (open && e.key === "Escape") handlers.onClose();
  };
  document.addEventListener("keydown", onKey);

  return {
    element: root,
    pill(p: PillState) {
      root.dataset.mic = p.mic;
      pill.title = p.title;
    },
    render(view: SessionView) {
      open = view.phase !== "closed";
      root.dataset.phase = view.phase;
      root.dataset.hearing = String(view.hearing);
      if (open !== panel.isConnected) root.replaceChildren(style, open ? panel : pill);
      if (!open) return;
      state.textContent = PHASE_TEXT[view.phase];
      heard.textContent = view.heard ? `“${view.heard}”` : "";
      said.textContent = view.said;
      opts.replaceChildren(
        ...view.options.map((o) => {
          const b = document.createElement("button");
          b.type = "button";
          b.textContent = o.label;
          b.addEventListener("click", o.pick);
          return b;
        }),
      );
    },
    destroy() {
      document.removeEventListener("keydown", onKey);
      root.remove();
    },
  };
}

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
.hey-lumi{position:fixed;right:16px;bottom:96px;z-index:100000;font:13px/1.4 var(--lumiverse-font-family,system-ui,sans-serif);color:var(--lumiverse-text,#eee)}
.hey-lumi *{box-sizing:border-box}
.hey-lumi-pill{display:flex;align-items:center;gap:6px;margin-left:auto;padding:6px 10px;border-radius:999px;border:1px solid var(--lumiverse-border-light,#ffffff22);background:var(--lumiverse-bg-elevated,#222);color:inherit;cursor:pointer;font:inherit;box-shadow:0 2px 10px #0004}
.hey-lumi-dot{width:9px;height:9px;border-radius:50%;background:var(--lumiverse-text-dim,#888)}
.hey-lumi[data-mic=listening] .hey-lumi-dot{background:var(--lumiverse-primary,#8b5cf6)}
.hey-lumi[data-mic=paused] .hey-lumi-dot{background:var(--lumiverse-warning,#d97706)}
.hey-lumi[data-mic=error] .hey-lumi-dot{background:var(--lumiverse-danger,#dc2626)}
.hey-lumi[data-mic=starting] .hey-lumi-dot{opacity:.5}
.hey-lumi-panel{width:300px;padding:10px 12px;border-radius:14px;border:1px solid var(--lumiverse-border-light,#ffffff22);background:var(--lumiverse-bg-elevated,#222);box-shadow:0 6px 24px #0006}
.hey-lumi-head{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.hey-lumi-head b{flex:1;font-weight:600}
.hey-lumi[data-phase=listening] .hey-lumi-panel .hey-lumi-dot{background:var(--lumiverse-primary,#8b5cf6)}
.hey-lumi[data-hearing=true] .hey-lumi-panel .hey-lumi-dot{animation:hey-lumi-pulse .8s ease-in-out infinite alternate}
.hey-lumi[data-phase=thinking] .hey-lumi-panel .hey-lumi-dot{background:var(--lumiverse-warning,#d97706)}
.hey-lumi[data-phase=asking] .hey-lumi-panel .hey-lumi-dot,.hey-lumi[data-phase=confirming] .hey-lumi-panel .hey-lumi-dot{background:var(--lumiverse-success,#16a34a)}
@keyframes hey-lumi-pulse{to{transform:scale(1.5)}}
.hey-lumi-x{border:0;background:none;color:var(--lumiverse-text-muted,#aaa);cursor:pointer;font-size:16px;line-height:1;padding:2px 4px}
.hey-lumi-heard{color:var(--lumiverse-text-muted,#aaa);font-style:italic;margin:2px 0;overflow-wrap:anywhere}
.hey-lumi-said{margin:4px 0;overflow-wrap:anywhere;white-space:pre-wrap}
.hey-lumi-options{display:flex;flex-wrap:wrap;gap:6px;margin:6px 0}
.hey-lumi-options button{padding:4px 10px;border-radius:8px;border:1px solid var(--lumiverse-primary-050,#8b5cf680);background:var(--lumiverse-primary-015,#8b5cf626);color:inherit;cursor:pointer;font:inherit}
.hey-lumi-type{width:100%;margin-top:6px;padding:5px 8px;border-radius:8px;border:1px solid var(--lumiverse-border-light,#ffffff22);background:var(--lumiverse-input-bg,#0003);color:inherit;font:inherit}
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
  root.className = "hey-lumi";
  root.setAttribute("data-hey-lumi", "");
  root.append(style);

  const pill = document.createElement("button");
  pill.type = "button";
  pill.className = "hey-lumi-pill";
  pill.innerHTML = '<span class="hey-lumi-dot"></span><span>Lumi</span>';
  pill.addEventListener("click", handlers.onPill);

  const panel = document.createElement("div");
  panel.className = "hey-lumi-panel";
  panel.setAttribute("role", "dialog");
  panel.setAttribute("aria-label", "Hey Lumi!");
  const head = document.createElement("div");
  head.className = "hey-lumi-head";
  const state = document.createElement("b");
  const x = document.createElement("button");
  x.type = "button";
  x.className = "hey-lumi-x";
  x.setAttribute("aria-label", "Close Lumi");
  x.textContent = "×";
  x.addEventListener("click", handlers.onClose);
  head.append(Object.assign(document.createElement("span"), { className: "hey-lumi-dot" }), state, x);
  const heard = document.createElement("div");
  heard.className = "hey-lumi-heard";
  const said = document.createElement("div");
  said.className = "hey-lumi-said";
  said.setAttribute("aria-live", "polite");
  const opts = document.createElement("div");
  opts.className = "hey-lumi-options";
  const input = document.createElement("input");
  input.className = "hey-lumi-type";
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

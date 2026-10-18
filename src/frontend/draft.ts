import type { FrontendCtx } from "../shared/host-ext";
import { CAP, hasCap } from "../shared/host-ext";

/**
 * The chat composer draft. ctx.composer (composer-v1) when the host has it; otherwise the DOM textarea
 * `textarea[name="chat-message"]` written with the native value setter + a bubbling input event, so React's onChange
 * sees it (host InputArea.tsx:4485-4502).
 */
export interface Draft {
  readonly via: "composer" | "dom";
  /** A composer is on screen. */
  available(): boolean;
  get(): string;
  set(text: string): void;
  focus(): void;
  /** Send like the Send button. */
  send(): Promise<void>;
}

export function findComposerTextarea(doc: Document = document): HTMLTextAreaElement | null {
  return doc.querySelector<HTMLTextAreaElement>('textarea[name="chat-message"]');
}

/** The button next to the textarea: Send, or Stop while generating (InputArea.tsx:4505-4560). */
export function findComposerButton(doc: Document = document): HTMLButtonElement | null {
  return findComposerTextarea(doc)?.parentElement?.nextElementSibling?.querySelector<HTMLButtonElement>("button") ?? null;
}

export function setNativeValue(el: HTMLTextAreaElement, text: string): void {
  const setter = Object.getOwnPropertyDescriptor(Object.getPrototypeOf(el), "value")?.set;
  if (setter) setter.call(el, text);
  else el.value = text;
  const EventCtor = el.ownerDocument.defaultView?.Event ?? Event;
  el.dispatchEvent(new EventCtor("input", { bubbles: true }));
}

export function createDraft(ctx: FrontendCtx): Draft {
  const composer = ctx.composer && hasCap(ctx.host, CAP.composer) ? ctx.composer : null;
  if (composer) {
    return {
      via: "composer",
      available: () => composer.getState().mounted,
      get: () => composer.getState().text,
      set: (text) => composer.setText(text),
      focus: () => composer.focus(),
      send: () => composer.send(),
    };
  }
  const area = () => {
    const el = findComposerTextarea();
    if (!el) throw new Error("COMPOSER_UNAVAILABLE: no chat input on screen.");
    return el;
  };
  return {
    via: "dom",
    available: () => !!findComposerTextarea(),
    get: () => findComposerTextarea()?.value ?? "",
    set: (text) => setNativeValue(area(), text),
    focus: () => area().focus(),
    async send() {
      area();
      const button = findComposerButton();
      if (!button || button.disabled) throw new Error("COMPOSER_BUSY: the send button is not available right now.");
      button.click();
    },
  };
}

/** Add dictated text to a draft: a paragraph break after existing text, or a space when continuing Lumi's own last insert. */
export function appendDictation(current: string, addition: string, continuing: boolean): string {
  const base = current.replace(/\s+$/, "");
  if (!base) return addition;
  return base + (continuing ? " " : "\n\n") + addition;
}

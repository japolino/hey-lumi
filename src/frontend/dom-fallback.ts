import type { DomControl } from "../shared/protocol";

const CONTROL_SELECTOR = [
  "button",
  "a[href]",
  "[role=button]",
  "[role=tab]",
  "[role=menuitem]",
  "[role=switch]",
  "[role=checkbox]",
  "input:not([type=hidden])",
  "select",
  "textarea",
  "summary",
].join(",");
const MAX_CONTROLS = 150;
const DESTRUCTIVE = /\b(delete|remove|erase|reset|clear|discard|destroy|wipe|uninstall|revoke|log ?out|sign ?out)\b/i;

function visible(el: HTMLElement, win: Window): boolean {
  const r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0 || r.bottom < 0 || r.right < 0 || r.top > win.innerHeight || r.left > win.innerWidth) return false;
  const style = win.getComputedStyle(el);
  return style.visibility !== "hidden" && style.display !== "none" && !el.closest("[aria-hidden=true],[inert]");
}

function clean(text: string | null | undefined): string {
  return (text ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
}

function labelOf(el: HTMLElement): string {
  const aria = clean(el.getAttribute("aria-label")) || clean(el.getAttribute("title"));
  if (aria) return aria;
  if (el instanceof HTMLInputElement || el instanceof HTMLSelectElement || el instanceof HTMLTextAreaElement) {
    const byFor = el.id ? el.ownerDocument.querySelector(`label[for="${CSS.escape(el.id)}"]`) : null;
    return clean(byFor?.textContent) || clean(el.closest("label")?.textContent) || clean(el.getAttribute("placeholder")) || clean(el.getAttribute("name"));
  }
  return clean(el.textContent);
}

function roleOf(el: HTMLElement): string {
  const role = el.getAttribute("role");
  if (role) return role;
  if (el instanceof HTMLAnchorElement) return "link";
  if (el instanceof HTMLInputElement) return el.type === "checkbox" || el.type === "radio" ? el.type : "input";
  return el.tagName.toLowerCase();
}

/** Text of the closest heading-like context: a dialog title, a section heading, or the host component name. */
function contextOf(el: HTMLElement): string | undefined {
  for (let node = el.parentElement, depth = 0; node && depth < 8; node = node.parentElement, depth++) {
    const heading = node.querySelector(":scope > h1, :scope > h2, :scope > h3, :scope > h4, :scope > header, :scope > legend");
    const text = clean(heading?.textContent);
    if (text && !heading?.contains(el)) return text;
    const component = node.getAttribute("data-component");
    if (component) return component;
  }
  return undefined;
}

/** Visible labelled controls of the host page (outside `exclude`, i.e. Lumi's own bubble). */
export function collectControls(doc: Document, exclude: Element | null): { controls: DomControl[]; elements: Map<string, HTMLElement> } {
  const win = doc.defaultView ?? window;
  const controls: DomControl[] = [];
  const elements = new Map<string, HTMLElement>();
  const seen = new Set<string>();
  for (const el of doc.querySelectorAll<HTMLElement>(CONTROL_SELECTOR)) {
    if (controls.length >= MAX_CONTROLS) break;
    if ((exclude && exclude.contains(el)) || (el as HTMLButtonElement).disabled || !visible(el, win)) continue;
    const label = labelOf(el);
    if (!label) continue;
    const context = contextOf(el);
    const key = `${label}|${context ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const id = `c${controls.length}`;
    elements.set(id, el);
    controls.push({ id, label, role: roleOf(el), ...(context ? { context } : {}), destructiveLooking: DESTRUCTIVE.test(label) });
  }
  return { controls, elements };
}

/** Text fields get focus; everything else is clicked. */
export function activateControl(el: HTMLElement): "focused" | "clicked" {
  if (el instanceof HTMLTextAreaElement || (el instanceof HTMLInputElement && !["checkbox", "radio", "button", "submit"].includes(el.type))) {
    el.focus();
    return "focused";
  }
  el.focus({ preventScroll: true });
  el.click();
  return "clicked";
}

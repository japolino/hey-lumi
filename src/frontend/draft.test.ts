import { expect, test } from "bun:test";
import { Window } from "happy-dom";
import { appendDictation, findComposerButton, setNativeValue } from "./draft";

test("dictation appends after a paragraph break, or a space when continuing Lumi's insert", () => {
  expect(appendDictation("", "She nods.", false)).toBe("She nods.");
  expect(appendDictation("Hello there.  \n", "She nods.", false)).toBe("Hello there.\n\nShe nods.");
  expect(appendDictation("She nods.", "\"Okay.\"", true)).toBe("She nods. \"Okay.\"");
});

test("native value setter + input event reaches an input listener; the send button is next to the textarea", () => {
  const window = new Window();
  const doc = window.document as unknown as Document;
  doc.body.innerHTML = '<div data-component="InputArea"><div><textarea name="chat-message"></textarea></div><div><button>send</button></div></div>';
  const area = doc.querySelector("textarea") as HTMLTextAreaElement;
  const seen: string[] = [];
  area.addEventListener("input", () => seen.push(area.value));
  setNativeValue(area, "typed by voice");
  expect(seen).toEqual(["typed by voice"]);
  expect(findComposerButton(doc)?.textContent).toBe("send");
});

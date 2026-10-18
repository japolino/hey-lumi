import { expect, test } from "bun:test";
import { createEntityLists } from "./entities";
import { createHandlers, errorResponse, handleRpc, recentFirst } from "./handlers";
import { createFakeHost } from "./testing/fake-host";

function setup() {
  const fake = createFakeHost();
  const handlers = createHandlers(fake.host, createEntityLists(fake.host), () => {
    throw new Error("services not used here");
  });
  return { fake, handlers };
}

test("swipe moves the last reply's swipe and stops at the ends", async () => {
  const { fake, handlers } = setup();
  fake.state.messages.set("c1", [
    { id: "m1", is_user: false, content: "a", swipe_id: 0, swipes: ["a"] },
    { id: "m2", is_user: true, content: "hi", swipe_id: 0, swipes: ["hi"] },
    { id: "m3", is_user: false, content: "y", swipe_id: 1, swipes: ["x", "y"] },
  ]);
  expect(await handlers.swipe({ chatId: "c1", direction: "left" })).toEqual({ ok: true });
  expect(fake.state.updates).toEqual([{ chatId: "c1", messageId: "m3", patch: { swipe_id: 0 } }]);
  expect((await handlers.swipe({ chatId: "c1", direction: "right" })).ok).toBe(false);
});

test("profile lists: decision connections, and no embedding list without the embeddings API", async () => {
  const { handlers } = setup();
  expect(await handlers.listProfiles({})).toEqual({ decision: [{ id: "d1", name: "Jev", isDefault: true }], embedding: null });
});

test("entity lists page through characters, cache, and skip kinds without permission", async () => {
  const fake = createFakeHost({ granted: ["characters"] });
  fake.state.characters = Array.from({ length: 450 }, (_, i) => ({ id: `c${i}`, name: `Char ${i}`, tags: [], image_id: null }));
  const lists = createEntityLists(fake.host);
  expect((await lists.get("character"))?.length).toBe(450);
  await lists.get("character");
  expect(fake.state.characterPages).toBe(3);
  expect(await lists.get("persona")).toBeUndefined();
});

test("rpc errors keep their code", async () => {
  const { handlers } = setup();
  const res = await handleRpc(handlers, { type: "hey_lumi:req", id: "1", method: "swipe", params: { chatId: "none", direction: "left" } });
  expect(res).toEqual({ type: "hey_lumi:res", id: "1", ok: true, result: { ok: false, say: "There is no reply to swipe." } });
  expect(errorResponse("2", new Error("PERMISSION_DENIED: decisions"))).toMatchObject({ ok: false, error: { code: "PERMISSION_DENIED" } });
  expect(errorResponse("3", new Error("boom"))).toMatchObject({ error: { code: "HEY_LUMI_ERROR" } });
});

test("characters of recent chats come first, newest first, then host order", () => {
  const items = ["a", "b", "c", "d"].map((id) => ({ id, name: id }));
  expect(recentFirst(items, ["c", "a"]).map((e) => e.id)).toEqual(["c", "a", "b", "d"]);
});

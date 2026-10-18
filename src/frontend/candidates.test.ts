import { expect, test } from "bun:test";
import catalog from "../../spec/surface-catalog.json";
import type { HostSurfaceInfo } from "../shared/host-ext";
import { buildCandidates, parseSurfaceActionId, themeOptions } from "./candidates";

const surfaces = catalog.surfaces as HostSurfaceInfo[];

test("candidates drop param routes, modals and panel/settings duplicates, and add Lumi actions", () => {
  const ids = buildCandidates(surfaces).map((c) => c.id);
  expect(ids).toContain("surface:drawer_tab:theme");
  expect(ids).toContain("surface:settings_tab:voice");
  expect(ids).toContain("surface:route:/");
  expect(ids).not.toContain("surface:route:/chat/:chatId");
  expect(ids).not.toContain("surface:modal:character_editor");
  expect(ids).not.toContain("surface:command:panel-theme");
  expect(ids).not.toContain("surface:command:settings-voice");
  expect(ids).toContain("surface:command:panel-ooc");
  expect(ids).not.toContain("surface:command:action-import-character");
  expect(ids).toContain("lumi:character_chat_new");
  expect(new Set(ids).size).toBe(ids.length);
});

test("host stop/swipe commands are wrapped by Lumi actions, and delete commands are destructive", () => {
  const withCommands: HostSurfaceInfo[] = [
    ...surfaces,
    { kind: "command", id: "action-stop-generation", label: "Stop Generation" },
    { kind: "command", id: "action-swipe-left", label: "Previous Swipe" },
  ];
  const list = buildCandidates(withCommands);
  expect(list.some((c) => c.id === "surface:command:action-stop-generation")).toBe(false);
  expect(list.find((c) => c.id === "surface:command:action-delete-chat")?.destructive).toBe(true);
  expect(list.find((c) => c.id === "lumi:draft_clear")?.destructive).toBe(true);
  expect(list.find((c) => c.id === "surface:command:action-continue")?.destructive).toBeUndefined();
});

test("surface action ids round-trip, including route ids with slashes", () => {
  expect(parseSurfaceActionId("surface:route:/characters")).toEqual({ kind: "route", id: "/characters" });
  expect(parseSurfaceActionId("lumi:stop")).toBeNull();
});

test("theme options come from the apply_theme params schema", () => {
  const apply: HostSurfaceInfo = {
    kind: "entity_action",
    id: "apply_theme",
    label: "Apply theme",
    params: { type: "object", required: ["themeId"], properties: { themeId: { type: "string", description: "", oneOf: [{ const: "emerald", title: "Emerald" }] } } },
  };
  expect(themeOptions([apply])).toEqual([{ id: "emerald", name: "Emerald" }]);
  expect(themeOptions(surfaces)).toEqual([]);
});

test("settings tabs from the backend fill in when the catalog has none", () => {
  const noSettings = surfaces.filter((s) => s.kind !== "settings_tab" && !s.id.startsWith("settings-"));
  const fallback: HostSurfaceInfo[] = [{ kind: "settings_tab", id: "voice", label: "Voice & Speech" }];
  expect(buildCandidates(noSettings, fallback).some((c) => c.id === "surface:settings_tab:voice")).toBe(true);
  expect(buildCandidates(surfaces, fallback).filter((c) => c.id === "surface:settings_tab:voice").length).toBe(1);
});

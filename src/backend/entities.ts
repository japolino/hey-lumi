import type { BackendHost } from "../shared/host-ext";
import type { ArgKind, EntityOption } from "../shared/protocol";

const TTL_MS = 60_000;
const MAX_CHARACTERS = 2000;

type BackendKind = Extract<ArgKind, "character" | "persona" | "preset">;

/** Characters, personas and presets for the router, cached for a minute. Kinds without permission are left out. */
export function createEntityLists(host: BackendHost) {
  const cache = new Map<BackendKind, { at: number; items: EntityOption[] }>();

  async function load(kind: BackendKind): Promise<EntityOption[]> {
    if (kind === "character") {
      const items: EntityOption[] = [];
      for (let offset = 0; offset < MAX_CHARACTERS; offset += 200) {
        const page = await host.characters.list({ limit: 200, offset });
        for (const c of page.data) {
          items.push({ id: c.id, name: c.name, detail: c.tags.slice(0, 6).join(", ") || undefined, imageId: c.image_id ?? undefined });
        }
        if (page.data.length < 200 || items.length >= page.total) break;
      }
      return items;
    }
    if (kind === "persona") {
      const page = await host.personas.list({ limit: 500 });
      return page.data.map((p) => ({ id: p.id, name: p.name, detail: p.title || undefined, imageId: p.image_id ?? undefined }));
    }
    const page = await host.presets.list({ limit: 500 });
    return page.data.map((p) => ({ id: p.id, name: p.name }));
  }

  const permission: Record<BackendKind, string> = { character: "characters", persona: "personas", preset: "presets" };

  return {
    async get(kind: BackendKind): Promise<EntityOption[] | undefined> {
      if (!host.permissions.has(permission[kind])) return undefined;
      const hit = cache.get(kind);
      if (hit && Date.now() - hit.at < TTL_MS) return hit.items;
      const items = await load(kind);
      cache.set(kind, { at: Date.now(), items });
      return items;
    },
    clear() {
      cache.clear();
    },
  };
}

export type EntityLists = ReturnType<typeof createEntityLists>;

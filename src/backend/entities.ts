import type { BackendHost } from "../shared/host-ext";
import type { ArgKind, EntityOption } from "../shared/protocol";

const TTL_MS = 60_000;
const MAX_CHARACTERS = 2000;

type BackendKind = Extract<ArgKind, "character" | "persona" | "preset">;

/** Characters, personas and presets for the router, cached for a minute per user. Kinds without permission are left out. */
export function createEntityLists(host: BackendHost) {
  const cache = new Map<string, { at: number; items: EntityOption[] }>();

  async function load(kind: BackendKind, userId?: string): Promise<EntityOption[]> {
    if (kind === "character") {
      const items: EntityOption[] = [];
      for (let offset = 0; offset < MAX_CHARACTERS; offset += 200) {
        const page = await host.characters.list({ limit: 200, offset, ...(userId ? { userId } : {}) });
        for (const c of page.data) {
          items.push({ id: c.id, name: c.name, detail: c.tags.slice(0, 6).join(", ") || undefined, imageId: c.image_id ?? undefined });
        }
        if (page.data.length < 200 || items.length >= page.total) break;
      }
      return items;
    }
    if (kind === "persona") {
      const page = await host.personas.list({ limit: 500, ...(userId ? { userId } : {}) });
      return page.data.map((p) => ({ id: p.id, name: p.name, detail: p.title || undefined, imageId: p.image_id ?? undefined }));
    }
    const page = await host.presets.list({ limit: 500, ...(userId ? { userId } : {}) });
    return page.data.map((p) => ({ id: p.id, name: p.name }));
  }

  const permission: Record<BackendKind, string> = { character: "characters", persona: "personas", preset: "presets" };

  return {
    async get(kind: BackendKind, userId?: string): Promise<EntityOption[] | undefined> {
      if (!host.permissions.has(permission[kind])) return undefined;
      const key = `${userId ?? ""}:${kind}`;
      const hit = cache.get(key);
      if (hit && Date.now() - hit.at < TTL_MS) return hit.items;
      const items = await load(kind, userId);
      cache.set(key, { at: Date.now(), items });
      return items;
    },
    clear() {
      cache.clear();
    },
  };
}

export type EntityLists = ReturnType<typeof createEntityLists>;

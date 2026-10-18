import type { BackendHost } from "../../shared/host-ext";
import { CAP, hasCap } from "../../shared/host-ext";
import type { RouterSettings } from "../../shared/protocol";
import type { Services } from "./types";

/** Text of a host generation result: a string, {content}, {text} or OpenAI-style choices. */
export function generationText(result: unknown): string {
  if (typeof result === "string") return result;
  if (!result || typeof result !== "object") return "";
  const r = result as Record<string, unknown>;
  for (const key of ["content", "text", "output_text"]) {
    if (typeof r[key] === "string") return r[key] as string;
  }
  const choice = Array.isArray(r.choices) ? (r.choices[0] as Record<string, any> | undefined) : undefined;
  if (typeof choice?.message?.content === "string") return choice.message.content;
  if (typeof choice?.text === "string") return choice.text;
  return "";
}

/** Services for one request, using the profiles the frontend picked ("" = host default). */
export function createServices(host: BackendHost, settings: RouterSettings): Services {
  const embeddings = host.embeddings && hasCap(host.host, CAP.embeddings) ? host.embeddings : null;
  return {
    async decide(input, options) {
      const result = await host.decisions.evaluate(
        { ...input, ...(settings.decisionProfile ? { connection_id: settings.decisionProfile } : {}) },
        options,
      );
      return result.answers;
    },
    decisionImages: hasCap(host.host, CAP.decisionImages) && host.permissions.has("images"),
    async complete(messages, options = {}) {
      const parameters: Record<string, unknown> = {};
      if (options.temperature !== undefined) parameters.temperature = options.temperature;
      if (options.maxTokens !== undefined) parameters.max_tokens = options.maxTokens;
      const result = await host.generate.quiet({
        type: "quiet",
        messages,
        parameters,
        reasoning: { source: "off" },
        ...(settings.llmProfile ? { connection_id: settings.llmProfile } : {}),
        ...(options.signal ? { signal: options.signal } : {}),
      } as Parameters<BackendHost["generate"]["quiet"]>[0]);
      return generationText(result);
    },
    embed: embeddings
      ? async (texts, inputType) => {
          const vectors: number[][] = [];
          let cacheKey = "";
          let connectionId = settings.embeddingProfile || undefined;
          for (let i = 0; i < texts.length; i += 256) {
            const res = await embeddings.embed({ texts: texts.slice(i, i + 256), input_type: inputType, ...(connectionId ? { connection_id: connectionId } : {}) });
            connectionId = res.connection_id;
            cacheKey = `${res.connection_id}:${res.model}`;
            vectors.push(...res.embeddings);
          }
          return { vectors, cacheKey };
        }
      : null,
    async imageSize(imageId) {
      const image = await host.images.get(imageId);
      return image?.width && image.height ? { width: image.width, height: image.height } : null;
    },
    log(level, message) {
      host.log[level](`[lumi_voice] ${message}`);
    },
  };
}

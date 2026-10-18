Adds types for embedding text with the user's embedding connections. Companion to the Lumiverse PR (https://github.com/prolix-oc/Lumiverse/pull/472, branch `japolino:feat/spindle-embeddings`).

- `SpindleAPI.embeddings: SpindleEmbeddingsAPI`:
  - `listConnections({ userId? }): Promise<EmbeddingConnectionDTO[]>`
  - `embed(input: EmbeddingsEmbedInput, { signal? }): Promise<EmbeddingsEmbedResult>`
- `EmbeddingsEmbedInput`: `{ texts: string[]; connection_id?: string; input_type?: "query" | "passage"; userId?: string }`. Without `connection_id`, the host uses the user's primary embedding connection and never a fallback.
- `EmbeddingsEmbedResult`: `{ embeddings: number[][]; connection_id; model; dimensions }`. It names the connection and model that produced every vector, so callers can tell when stored vectors are stale.
- `EmbeddingConnectionDTO`: `id`, `name`, `provider`, `model`, `dimensions`, `enabled`, `is_primary`, `has_api_key` (no URL, no key).
- `EmbeddingsWorkerMessage` (`embeddings_connections_list`, `embeddings_embed`, `embeddings_cancel`) is added to `WorkerToHost`.
- New permission `embeddings` (in `SpindlePermission` and `ALL_PERMISSIONS`) and new host capability `embeddings-v1: 1`.

Also adds a consumer type test (`test/api-embeddings-consumer.ts`) and a permission/capability test (`test/embeddings.test.ts`), updates the capability snapshot test, and rebuilds dist. The version is not bumped. The repo has no CHANGELOG file, so this description is the change summary.

Checks: `npm run build`, `tsc -p tsconfig.consumer.json --noEmit`, `bun test` (18 pass), `npm run build:consumer`.

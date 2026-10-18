/**
 * Run the real Lumiverse install scanner on dist/backend.js.
 * Usage (from a Lumiverse checkout): bun run <lumi-voice>/scripts/scan.ts <lumi-voice>/dist/backend.js
 */
const lumiverse = process.cwd();
const { detectDangerousBackendCapabilities } = await import(`${lumiverse}/src/spindle/manager.service.ts`);
const file = process.argv[2]!;
const findings = detectDangerousBackendCapabilities(await Bun.file(file).text(), new Set());
console.log(JSON.stringify(findings));
process.exit(findings.length ? 1 : 0);

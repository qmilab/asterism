// @qmilab/asterism — the `asterism` CLI, importable surface.
//
// This is the package's main entry: it is IMPORT-SAFE — pure re-exports, no
// side effects. The executable lives in `bin.ts` (which `package.json` points
// `bin` at), so importing this module never runs the CLI or calls process.exit.
//
// Embedders can drive the same command surface programmatically via `runCli`,
// supplying their own `CliIO` (cwd, env, output sinks, store/adapter factories).

export { runCli } from "./cli.js";
export type { CliIO } from "./cli.js";
export { VERSION } from "./version.js";

// Packages the main-process bundle leaves to node_modules at runtime.
export const MAIN_PROCESS_EXTERNALS = [
  // Native N-API addon with per-platform binaries; loaded from
  // node_modules (unpacked from the asar) by the practice call.
  'onnxruntime-node',
  // Loads its .wasm (and asm.js fallback) from its own build/ folder by
  // relative path at runtime; bundled, those reads would miss. Used by the
  // practice call codec.
  'opusscript',
  // The SDK loads runtime files relative to its own package and
  // launches the user's installed Claude Code executable.
  '@anthropic-ai/claude-agent-sdk',
  // jsdom uses __dirname-relative readFileSync for browser/default-stylesheet.css;
  // bundling it corrupts that path to dist-electron/ instead of node_modules/jsdom/.
  'jsdom',
]

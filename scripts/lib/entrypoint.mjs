// True when the module whose `import.meta.url` is passed is the script node was started with.
// Both paths are resolved through symlinks (macOS /tmp is one), so running a script through a
// linked path still runs it. False when there is no script (node -e, a REPL) or it cannot be resolved.
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMainModule(moduleUrl, argv1 = process.argv[1]) {
  if (!argv1) return false;
  try { return fs.realpathSync(argv1) === fs.realpathSync(fileURLToPath(moduleUrl)); }
  catch { return false; }
}

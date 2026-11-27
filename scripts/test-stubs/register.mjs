// Entry point for `node --import`: registers the electron/electron-store
// stub loader before the test runner's own imports resolve.
//
// The no-provider-network guard is installed by scripts/run-tests.mjs itself
// (tests that exercise a transport replace it with a fake and restore it in `finally`).
import * as nodeModule from 'node:module';
import { resolve } from './loader.mjs';

if (typeof nodeModule.registerHooks === 'function') {
  nodeModule.registerHooks({ resolve });
} else {
  nodeModule.register('./loader.mjs', import.meta.url);
}

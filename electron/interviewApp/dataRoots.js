// Where Interview Helper keeps things.
//
// `profile` is the app's Electron folder (cookies, cache, single-instance lock,
// and the Claude worker's bookkeeping files that only one process may rewrite).
// `data` is the interview data: career text, prepared briefs, answer banks, Q&A,
// practice calls and the practice models. It is a folder of its own inside the
// profile. `legacy` is the Infinite Canvas folder that held this data before
// Interview Helper became its own app; it is only ever read, by the one-time copy
// in migrateFromCanvas.js.
import fs from 'node:fs';
import path from 'node:path';

const INTERVIEW_APP_PROFILE_DIRECTORY = 'Interview Helper';
const INTERVIEW_DATA_DIRECTORY = 'interview-data';
const LEGACY_DATA_DIRECTORY = 'infinite-canvas';

export function interviewAppDataRoots({ appDataPath, env = {} } = {}) {
  if (typeof appDataPath !== 'string' || !path.isAbsolute(appDataPath)) throw new TypeError('Interview Helper needs the application data path.');
  const override = name => (typeof env[name] === 'string' && path.isAbsolute(env[name]) ? path.resolve(env[name]) : null);
  // The overrides exist so tests and trial runs never touch real interview data.
  const profile = override('INTERVIEW_HELPER_PROFILE_DIR') || path.join(appDataPath, INTERVIEW_APP_PROFILE_DIRECTORY);
  const data = override('INTERVIEW_HELPER_DATA_DIR') || path.join(profile, INTERVIEW_DATA_DIRECTORY);
  const legacy = override('INTERVIEW_HELPER_LEGACY_DATA_DIR') || path.join(appDataPath, LEGACY_DATA_DIRECTORY);
  if (profile === data) throw new Error('Interview Helper needs a data folder separate from its profile folder.');
  return Object.freeze({
    profile, data, legacy,
    async ensure() {
      await fs.promises.mkdir(profile, { recursive: true, mode: 0o700 });
      await fs.promises.mkdir(data, { recursive: true, mode: 0o700 });
    },
  });
}

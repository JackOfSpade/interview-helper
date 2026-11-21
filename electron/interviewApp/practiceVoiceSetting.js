// The candidate's voice in practice calls: female or male. A sent chat message is spoken on the
// call in this voice (electron/practiceCall/candidateVoice.js). Both voices are drawn for every
// call, so a change applies to the next line, even mid-call.
import fs from 'node:fs';
import { atomicWriteFile } from '../utils/atomicWrite.js';
import { CANDIDATE_VOICE_GENDERS, DEFAULT_CANDIDATE_VOICE_GENDER, normalizeCandidateVoiceGender } from '../practiceCall/candidateVoice.js';

export const PRACTICE_VOICE_GET_CHANNEL = 'interview-app:get-practice-voice';
export const PRACTICE_VOICE_SET_CHANNEL = 'interview-app:set-practice-voice';

export const practiceVoiceState = gender => ({ gender: normalizeCandidateVoiceGender(gender), choices: [...CANDIDATE_VOICE_GENDERS], default: DEFAULT_CANDIDATE_VOICE_GENDER });

/** The saved setting. A missing or damaged file is the default; it is rewritten on the next change. */
export function createPracticeVoiceStore({ filePath, fsApi = fs } = {}) {
  if (typeof filePath !== 'string' || !filePath) throw new TypeError('The practice voice setting needs a file path.');
  let cached = null;
  const read = () => {
    if (cached) return cached;
    try { cached = normalizeCandidateVoiceGender(JSON.parse(fsApi.readFileSync(filePath, 'utf8'))?.gender); }
    catch { cached = DEFAULT_CANDIDATE_VOICE_GENDER; }
    return cached;
  };
  return Object.freeze({
    read,
    async write(gender) {
      const value = normalizeCandidateVoiceGender(gender);
      await atomicWriteFile(filePath, `${JSON.stringify({ version: 1, gender: value })}\n`, { mkdir: true });
      cached = value;
      return value;
    },
  });
}

export function registerPracticeVoiceHandlers({ ipcMain, guarded, store }) {
  ipcMain.handle(PRACTICE_VOICE_GET_CHANNEL, guarded(() => practiceVoiceState(store.read())));
  ipcMain.handle(PRACTICE_VOICE_SET_CHANNEL, guarded(async (args) => {
    const keys = args && typeof args === 'object' && !Array.isArray(args) ? Object.keys(args) : null;
    if (!keys || keys.length !== 1 || keys[0] !== 'gender' || !CANDIDATE_VOICE_GENDERS.includes(args.gender)) throw new TypeError('That voice is not one of the choices.');
    return practiceVoiceState(await store.write(args.gender));
  }));
}

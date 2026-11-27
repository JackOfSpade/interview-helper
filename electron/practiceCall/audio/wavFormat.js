// The 44-byte PCM16 mono WAV layout shared by the practice call audio files.
export const HEADER_BYTES = 44;
export const TWO_POW_15 = 32768;

/** A 44-byte header for `dataBytes` of PCM16 mono audio at `sampleRate`. */
export function wavHeader(dataBytes, sampleRate) {
  const header = Buffer.alloc(HEADER_BYTES);
  header.write('RIFF', 0, 'ascii');
  header.writeUInt32LE(36 + dataBytes, 4);
  header.write('WAVE', 8, 'ascii');
  header.write('fmt ', 12, 'ascii');
  header.writeUInt32LE(16, 16);
  header.writeUInt16LE(1, 20);
  header.writeUInt16LE(1, 22);
  header.writeUInt32LE(sampleRate, 24);
  header.writeUInt32LE(sampleRate * 2, 28);
  header.writeUInt16LE(2, 32);
  header.writeUInt16LE(16, 34);
  header.write('data', 36, 'ascii');
  header.writeUInt32LE(dataBytes, 40);
  return header;
}

/** Whole frames of PCM16 mono audio in a file of `size` bytes. */
export function pcm16FrameCount(size) {
  return Math.max(0, Math.floor((size - HEADER_BYTES) / 2));
}

/**
 * Reads and checks the header of an open PCM16 mono WAV. Errors start with `prefix`, then the
 * `subject` (the track's name) when there is one.
 */
export function readPcm16MonoHeader(fd, fs, { prefix, subject = '' } = {}) {
  const where = subject ? `${prefix}: ${subject}` : prefix;
  const header = Buffer.alloc(HEADER_BYTES);
  if (fs.readSync(fd, header, 0, HEADER_BYTES, 0) < HEADER_BYTES) throw new Error(`${where} header incomplete`);
  if (header.toString('ascii', 0, 4) !== 'RIFF' || header.toString('ascii', 8, 12) !== 'WAVE') {
    throw new Error(subject ? `${where} is not a RIFF/WAVE file` : `${prefix}: not a RIFF/WAVE file`);
  }
  const audioFormat = header.readUInt16LE(20);
  const channels = header.readUInt16LE(22);
  const sampleRate = header.readUInt32LE(24);
  const bits = header.readUInt16LE(34);
  if (audioFormat !== 1 || bits !== 16 || channels !== 1) {
    throw new Error(`${where} must be PCM16 mono, got format ${audioFormat} channels ${channels} bits ${bits}`);
  }
  return { sampleRate, channels };
}

/**
 * Reads `count` frames of an open PCM16 mono WAV, starting at frame `startFrame`, as floats in [-1, 1).
 * A short read (the file is still growing, or ended early) returns only the frames that were there.
 */
export function readPcm16Floats(fd, fs, startFrame, count) {
  if (!(count > 0)) return new Float32Array(0);
  const raw = Buffer.alloc(count * 2);
  let got = 0;
  while (got < raw.length) {
    const n = fs.readSync(fd, raw, got, raw.length - got, HEADER_BYTES + startFrame * 2 + got);
    if (n <= 0) break;
    got += n;
  }
  const out = new Float32Array(got >> 1);
  for (let i = 0; i < out.length; i += 1) out[i] = raw.readInt16LE(i * 2) / TWO_POW_15;
  return out;
}

// Interview practice call audio: microphone capture, voice-processed playback
// (one shared AVAudioEngine so the echo canceller has the playback reference),
// on-device transcription and a local 16 kHz WAV recording.
// Stdout is a private bounded NDJSON pipe to Electron, not a transcript log.
// Transcript text is never written to stderr, a file or anywhere but stdout.
import Foundation
import AppKit
import Speech
import AVFoundation
import CoreMedia
import Darwin

final class ProtocolWriter: @unchecked Sendable {
    private let lock = NSLock()
    func send(_ value: [String: Any]) {
        guard JSONSerialization.isValidJSONObject(value),
              var data = try? JSONSerialization.data(withJSONObject: value), data.count < 16_384 else { return }
        data.append(0x0A)
        lock.lock()
        defer { lock.unlock() }
        // A closed owner pipe must never become an audio/transcript file.
        do { try FileHandle.standardOutput.write(contentsOf: data) }
        catch { Darwin.exit(0) }
    }
}

enum HelperFailure: Error {
    case code(String)
    var code: String { switch self { case .code(let value): return value } }
}

/// Every VAD tuning constant lives here; Phase 3 tunes these values.
struct PracticeVadTuning {
    /// Analysis window for energy measurement.
    static let windowMs: Double = 10
    /// Speech starts after this much continuous energy above the threshold.
    static let startHoldMs: Double = 100
    /// Speech ends after this much continuous energy below the threshold.
    static let endHoldMs: Double = 200
    /// Threshold = max(absoluteMinThreshold, noiseFloor * thresholdRatio) (linear RMS).
    static let thresholdRatio: Float = 3.0
    static let absoluteMinThreshold: Float = 0.006
    static let initialNoiseFloor: Float = 0.002
    static let minNoiseFloor: Float = 0.0003
    static let maxNoiseFloor: Float = 0.05
    /// Per-window adaptation of the floor (falls fast, rises slowly).
    static let noiseFloorFallRate: Float = 0.1
    static let noiseFloorRiseRate: Float = 0.003
}

/// Energy VAD with an adaptive noise floor. Times are timeline milliseconds;
/// the reported time is the onset/offset of the run, not the detection time.
struct EnergyVad {
    private(set) var speaking = false
    private var noiseFloor = PracticeVadTuning.initialNoiseFloor
    private var aboveMs = 0.0
    private var belowMs = 0.0
    private var runStartMs = 0.0

    mutating func reset() { speaking = false; aboveMs = 0; belowMs = 0 }

    mutating func process(rms: Float, startMs: Double, durationMs: Double) -> (speaking: Bool, atMs: Double)? {
        let threshold = max(PracticeVadTuning.absoluteMinThreshold, noiseFloor * PracticeVadTuning.thresholdRatio)
        let above = rms > threshold
        if !speaking {
            let rate = rms < noiseFloor ? PracticeVadTuning.noiseFloorFallRate : PracticeVadTuning.noiseFloorRiseRate
            noiseFloor += (rms - noiseFloor) * rate
            noiseFloor = min(max(noiseFloor, PracticeVadTuning.minNoiseFloor), PracticeVadTuning.maxNoiseFloor)
        }
        if !speaking {
            if above {
                if aboveMs == 0 { runStartMs = startMs }
                aboveMs += durationMs
                if aboveMs >= PracticeVadTuning.startHoldMs {
                    speaking = true; aboveMs = 0; belowMs = 0
                    return (true, runStartMs)
                }
            } else { aboveMs = 0 }
        } else {
            if above { belowMs = 0 }
            else {
                if belowMs == 0 { runStartMs = startMs }
                belowMs += durationMs
                if belowMs >= PracticeVadTuning.endHoldMs {
                    speaking = false; belowMs = 0; aboveMs = 0
                    return (false, runStartMs)
                }
            }
        }
        return nil
    }
}

/// 16 kHz mono 16-bit PCM WAV. Created exclusively (never overwrites, never
/// follows a symlink) with mode 0600. Header sizes are patched on finalize.
final class WavWriter: @unchecked Sendable {
    static let sampleRate = 16_000
    private var fd: Int32
    private(set) var frames: Int64 = 0
    private var finalized = false

    init(path: String) throws {
        let descriptor = Darwin.open(path, O_WRONLY | O_CREAT | O_EXCL | O_NOFOLLOW | O_CLOEXEC, 0o600)
        guard descriptor >= 0 else { throw HelperFailure.code("recording-failed") }
        fd = descriptor
        do { try writeAll(Self.header(dataBytes: 0)) }
        catch { Darwin.close(descriptor); fd = -1; throw error }
    }

    private static func header(dataBytes: UInt32) -> [UInt8] {
        func le32(_ v: UInt32) -> [UInt8] { (0..<4).map { UInt8((v >> (8 * UInt32($0))) & 0xFF) } }
        func le16(_ v: UInt16) -> [UInt8] { [UInt8(v & 0xFF), UInt8(v >> 8)] }
        var h: [UInt8] = Array("RIFF".utf8)
        h += le32(36 &+ dataBytes)
        h += Array("WAVEfmt ".utf8)
        h += le32(16) + le16(1) + le16(1)
        h += le32(UInt32(sampleRate)) + le32(UInt32(sampleRate * 2)) + le16(2) + le16(16)
        h += Array("data".utf8) + le32(dataBytes)
        return h
    }

    private func writeAll(_ bytes: [UInt8]) throws {
        try bytes.withUnsafeBytes { try writeRaw($0.baseAddress, $0.count) }
    }

    private func writeRaw(_ base: UnsafeRawPointer?, _ count: Int) throws {
        guard fd >= 0, let base else { throw HelperFailure.code("recording-failed") }
        var offset = 0
        while offset < count {
            let written = Darwin.write(fd, base + offset, count - offset)
            if written < 0 {
                if errno == EINTR { continue }
                throw HelperFailure.code("recording-failed")
            }
            offset += written
        }
    }

    private func hasRoom(for newFrames: Int) -> Bool {
        (frames + Int64(newFrames)) * 2 <= Int64(UInt32.max - 36)
    }

    func append(_ samples: UnsafePointer<Int16>, count: Int) throws {
        guard count > 0, !finalized else { return }
        guard hasRoom(for: count) else { throw HelperFailure.code("recording-failed") }
        try writeRaw(UnsafeRawPointer(samples), count * 2)
        frames += Int64(count)
    }

    func appendSilence(frames count: Int) throws {
        guard count > 0, !finalized else { return }
        guard hasRoom(for: count) else { throw HelperFailure.code("recording-failed") }
        let chunk = [UInt8](repeating: 0, count: 8192)
        var remaining = count * 2
        while remaining > 0 {
            let n = min(remaining, chunk.count)
            try chunk.withUnsafeBytes { try writeRaw($0.baseAddress, n) }
            remaining -= n
        }
        frames += Int64(count)
    }

    /// Patches the header sizes, fsyncs and closes. Idempotent. Returns duration.
    @discardableResult
    func finalize() -> Int? {
        guard !finalized else { return nil }
        finalized = true
        guard fd >= 0 else { return nil }
        let bytes = UInt32(clamping: frames * 2)
        let header = Self.header(dataBytes: bytes)
        var ok = false
        if Darwin.lseek(fd, 0, SEEK_SET) == 0 {
            ok = header.withUnsafeBytes { raw -> Bool in
                var offset = 0
                while offset < raw.count {
                    let n = Darwin.write(fd, raw.baseAddress! + offset, raw.count - offset)
                    if n < 0 { if errno == EINTR { continue }; return false }
                    offset += n
                }
                return true
            }
        }
        _ = Darwin.fsync(fd)
        Darwin.close(fd); fd = -1
        return ok ? Int(frames * 1000 / Int64(Self.sampleRate)) : nil
    }

    static func validate(path: String) -> Bool {
        guard path.hasPrefix("/"), path.hasSuffix(".wav"), path.utf8.count < 4096,
              !path.contains("\0") else { return false }
        let parent = (path as NSString).deletingLastPathComponent
        var isDirectory: ObjCBool = false
        guard !parent.isEmpty, FileManager.default.fileExists(atPath: parent, isDirectory: &isDirectory),
              isDirectory.boolValue else { return false }
        var info = stat()
        return lstat(path, &info) != 0 && errno == ENOENT
    }
}

enum Command: Sendable {
    case play(id: String, sampleRate: Int)
    case audio(id: String, pcm: Data)
    case end(id: String)
    case cancel(id: String)
    case pause(id: String)
    case resume(id: String)
    case mute(Bool)
    case inject(id: String, sampleRate: Int)
    case injectAudio(id: String, pcm: Data)
    case injectEnd(id: String)
    case injectCancel(id: String, fadeMs: Int)
    /// The candidate asked to try the microphone again after it stopped working (or after access was granted).
    case reconnectMicrophone
    case stop

    static let maxLineBytes = 262_144
    /// Largest `inject-audio` chunk before base64 (the wrapper's chunk size).
    static let maxInjectChunkBytes = 96_000

    static func validID(_ value: Any?) -> String? {
        guard let id = value as? String, (1...64).contains(id.utf8.count),
              id.utf8.allSatisfy({ ($0 >= 0x30 && $0 <= 0x39) || ($0 >= 0x41 && $0 <= 0x5A)
                  || ($0 >= 0x61 && $0 <= 0x7A) || $0 == 0x5F || $0 == 0x2D }) else { return nil }
        return id
    }

    static func parse(_ line: Data) -> Command? {
        guard line.count <= maxLineBytes,
              let object = try? JSONSerialization.jsonObject(with: line) as? [String: Any],
              let type = object["type"] as? String else { return nil }
        switch type {
        case "play":
            guard let id = validID(object["utteranceId"]), let rate = object["sampleRate"] as? Int,
                  rate == 24_000 || rate == 44_100 else { return nil }
            return .play(id: id, sampleRate: rate)
        case "audio":
            guard let id = validID(object["utteranceId"]), let text = object["pcm"] as? String,
                  let data = Data(base64Encoded: text) else { return nil }
            return .audio(id: id, pcm: data)
        case "end":
            guard let id = validID(object["utteranceId"]) else { return nil }
            return .end(id: id)
        case "cancel":
            guard let id = validID(object["utteranceId"]) else { return nil }
            return .cancel(id: id)
        case "pause":
            guard let id = validID(object["utteranceId"]) else { return nil }
            return .pause(id: id)
        case "resume":
            guard let id = validID(object["utteranceId"]) else { return nil }
            return .resume(id: id)
        case "mute":
            guard let muted = object["muted"] as? Bool else { return nil }
            return .mute(muted)
        case "inject":
            guard let id = validID(object["utteranceId"]), let rate = object["sampleRate"] as? Int,
                  rate == 16_000 || rate == 24_000 || rate == 44_100 else { return nil }
            return .inject(id: id, sampleRate: rate)
        case "inject-audio":
            guard let id = validID(object["utteranceId"]), let text = object["pcm"] as? String,
                  let data = Data(base64Encoded: text), data.count <= maxInjectChunkBytes else { return nil }
            return .injectAudio(id: id, pcm: data)
        case "inject-end":
            guard let id = validID(object["utteranceId"]) else { return nil }
            return .injectEnd(id: id)
        case "inject-cancel":
            guard let id = validID(object["utteranceId"]) else { return nil }
            var fade = 60
            if let raw = object["fadeMs"] {
                guard let value = raw as? Int, (0...500).contains(value) else { return nil }
                fade = value
            }
            return .injectCancel(id: id, fadeMs: fade)
        case "reconnect-microphone": return .reconnectMicrophone
        case "stop": return .stop
        default: return nil
        }
    }
}

/// Bounded line reader: oversized lines are discarded without buffering them.
enum StdinReader {
    /// `onLine` returns false to stop reading.
    static func run(_ onLine: (Data) -> Bool) {
        var pending = Data()
        var discarding = false
        var chunk = [UInt8](repeating: 0, count: 65_536)
        while true {
            let count = chunk.withUnsafeMutableBytes { Darwin.read(0, $0.baseAddress, $0.count) }
            if count < 0 { if errno == EINTR { continue }; return }
            if count == 0 { return }
            for byte in chunk[0..<count] {
                if byte == 0x0A {
                    if !discarding, !pending.isEmpty, !onLine(pending) { return }
                    pending.removeAll(keepingCapacity: true); discarding = false
                } else if !discarding {
                    pending.append(byte)
                    if pending.count > Command.maxLineBytes { pending.removeAll(); discarding = true }
                }
            }
        }
    }
}

/// Shared monotonic timeline (milliseconds since mic capture started). The mic
/// queue advances it by captured sample counts; other threads read an estimate.
final class TimelineClock: @unchecked Sendable {
    private let lock = NSLock()
    private var endSec = 0.0
    private var arrival = ProcessInfo.processInfo.systemUptime
    private var lastReported = 0

    func publish(endSec: Double, arrival: TimeInterval) {
        lock.lock(); self.endSec = endSec; self.arrival = arrival; lock.unlock()
    }

    func nowMs() -> Int {
        lock.lock(); defer { lock.unlock() }
        let elapsed = min(max(ProcessInfo.processInfo.systemUptime - arrival, 0), 0.25)
        lastReported = max(lastReported, Int(((endSec + elapsed) * 1000).rounded()))
        return lastReported
    }
}

/// Which stretches of the timeline carry an injected line. While the microphone is muted,
/// transcripts are dropped unless they overlap one of these (the line is "spoken" on the mic).
final class InjectSpans: @unchecked Sendable {
    private let lock = NSLock()
    private var spans: [(id: String, startMs: Int, endMs: Int)] = []

    func open(id: String, startMs: Int) {
        lock.lock(); defer { lock.unlock() }
        spans.append((id, startMs, Int.max))
        if spans.count > 32 { spans.removeFirst(spans.count - 32) }
    }

    func close(id: String, endMs: Int) {
        lock.lock(); defer { lock.unlock() }
        for index in spans.indices where spans[index].id == id && spans[index].endMs == Int.max {
            spans[index].endMs = endMs
        }
    }

    func overlaps(startMs: Int, endMs: Int) -> Bool {
        lock.lock(); defer { lock.unlock() }
        return spans.contains { $0.startMs <= endMs && startMs <= $0.endMs }
    }
}

/// Mic buffers arrive on the render thread; they are only copied there. All
/// conversion, injection, VAD, analyzer feeding and WAV writing happen on `queue`.
/// An injected line (the candidate's AI voice) is summed into the mono microphone
/// samples at the start of `process`, so it takes exactly the path real speech takes.
final class MicProcessor: @unchecked Sendable {
    /// One injected line: PCM waiting for conversion, then a FIFO at the mic rate.
    private final class InjectLine {
        let id: String
        let lineRate: Double
        var pending: [Float] = []   // at the line's rate, not yet converted
        var fifo: [Float] = []      // at `targetRate`
        var read = 0
        var converter: AVAudioConverter?
        var targetRate = 0.0
        var carry: UInt8?
        var receivedFrames: Int64 = 0
        var ended = false
        var flushOwed = false   // inject-end arrived before the mic rate was known
        var started = false
        var mixedSec = 0.0
        var lastPositionSec = -1.0
        var lastCount = 0
        var fading = false
        var fadeTotal = 1
        var fadeLeft = 0
        init(id: String, lineRate: Double) { self.id = id; self.lineRate = lineRate }
        var available: Int { fifo.count - read }
    }

    private static let maxInjectSeconds = 600.0
    private static let injectTailSec = 0.4

    private let queue = DispatchQueue(label: "practice-audio.mic", qos: .userInitiated)
    private let analyzerFormat: AVAudioFormat?
    private let input: AsyncStream<AnalyzerInput>.Continuation?
    private let writer: ProtocolWriter
    private let wav: WavWriter
    private let clock: TimelineClock
    private let spans: InjectSpans
    private let fail: @Sendable (String) -> Void
    private let wavFormat = AVAudioFormat(commonFormat: .pcmFormatInt16, sampleRate: 16_000,
                                          channels: 1, interleaved: true)!
    // Tap-thread state.
    private let formatLock = NSLock()
    private var monoFormat: AVAudioFormat?
    // Queue-confined state.
    private var analyzerConverter: AVAudioConverter?
    private var wavConverter: AVAudioConverter?
    private var sourceRate = 0.0
    private var timelineSec = 0.0
    private var lastArrival: TimeInterval?
    private var interrupted = false
    private var muted = false
    private var analyzerNeedsStart = true
    private var vad = EnergyVad()
    /// Speech on the raw microphone while muted, never heard by anyone: only tells the call to show "You're muted".
    private var mutedVad = EnergyVad()
    private var mutedRunMs = 0.0
    private var mutedRunReported = false
    private static let mutedSpeechMs = 400.0
    private var levelSumSquares = 0.0
    private var levelCount = 0
    private var timer: DispatchSourceTimer?
    private var stopped = false
    private var micFormat: AVAudioFormat?
    private var lines: [InjectLine] = []
    private var injectTailUntilSec = 0.0

    /// `analyzerFormat` and `input` are nil when on-device recognition is unavailable (a call
    /// without microphone access whose speech assets could not be prepared).
    init(analyzerFormat: AVAudioFormat?, input: AsyncStream<AnalyzerInput>.Continuation?,
         writer: ProtocolWriter, wav: WavWriter, clock: TimelineClock, spans: InjectSpans,
         fail: @escaping @Sendable (String) -> Void) {
        self.analyzerFormat = analyzerFormat; self.input = input; self.writer = writer
        self.wav = wav; self.clock = clock; self.spans = spans; self.fail = fail
    }

    /// Whether speech reaching this processor is transcribed. Without it a microphone could be heard but not understood.
    var recognizes: Bool { input != nil }

    func startLevelTimer() {
        queue.async {
            guard !self.stopped, self.timer == nil else { return }
            let timer = DispatchSource.makeTimerSource(queue: self.queue)
            timer.schedule(deadline: .now() + .milliseconds(100), repeating: .milliseconds(100))
            // Retained until stop() cancels the timer.
            timer.setEventHandler { self.emitLevel() }
            self.timer = timer
            timer.resume()
        }
    }

    func stop() async {
        await withCheckedContinuation { continuation in
            queue.async {
                self.stopped = true
                self.timer?.cancel(); self.timer = nil
                self.analyzerConverter = nil; self.wavConverter = nil
                self.lines.removeAll()
                self.input?.finish()
                continuation.resume()
            }
        }
    }

    func setMuted(_ value: Bool) {
        queue.async {
            guard !self.stopped, self.muted != value else { return }
            self.muted = value
            self.mutedVad.reset(); self.mutedRunMs = 0; self.mutedRunReported = false
            if value {
                // An injected line is still "spoken" while muted: keep its VAD and level state.
                if self.lines.isEmpty {
                    if self.vad.speaking { self.emitVad(false, atSec: self.timelineSec) }
                    self.vad.reset()
                    self.levelSumSquares = 0; self.levelCount = 0
                }
            } else {
                self.analyzerNeedsStart = true
                self.analyzerConverter = nil; self.wavConverter = nil; self.sourceRate = 0
            }
        }
    }

    /// The engine was reconfigured; the next buffer adds the gap as silence.
    func markInterruption() {
        queue.async { self.interrupted = true }
    }

    // MARK: Injection (the candidate's AI voice mixed into the microphone signal)

    /// Starts a line; a line that is still active is cancelled with a fast fade.
    func injectStart(id: String, sampleRate: Int) {
        queue.async {
            guard !self.stopped else { return }
            for line in self.lines where !line.fading { self.cancelLine(line, fadeMs: 30) }
            self.lines.append(InjectLine(id: id, lineRate: Double(sampleRate)))
        }
    }

    func injectAudio(id: String, pcm: Data) {
        queue.async {
            guard !self.stopped, let line = self.activeLine(id), !line.ended else { return }
            var bytes = [UInt8]()
            bytes.reserveCapacity(pcm.count + 1)
            if let carry = line.carry { bytes.append(carry); line.carry = nil }
            bytes.append(contentsOf: pcm)
            if bytes.count % 2 == 1 { line.carry = bytes.removeLast() }
            let frames = bytes.count / 2
            guard frames > 0,
                  Double(line.receivedFrames + Int64(frames)) / line.lineRate <= Self.maxInjectSeconds else { return }
            line.receivedFrames += Int64(frames)
            line.pending.reserveCapacity(line.pending.count + frames)
            for index in 0..<frames {
                let sample = Int16(bitPattern: UInt16(bytes[index * 2]) | (UInt16(bytes[index * 2 + 1]) << 8))
                line.pending.append(Float(sample) / 32768)
            }
            self.convertPending(line, flush: false)
        }
    }

    func injectEnd(id: String) {
        queue.async {
            guard !self.stopped, let line = self.activeLine(id), !line.ended else { return }
            line.ended = true
            self.convertPending(line, flush: true)
        }
    }

    func injectCancel(id: String, fadeMs: Int) {
        queue.async {
            guard !self.stopped, let line = self.activeLine(id) else { return }
            self.cancelLine(line, fadeMs: fadeMs)
        }
    }

    /// Every line stops at once (the engine was reconfigured and the monitor is gone).
    func injectCancelAll() {
        queue.async {
            for line in self.lines where !line.fading { self.cancelLine(line, fadeMs: 0) }
        }
    }

    private func activeLine(_ id: String) -> InjectLine? {
        lines.first { $0.id == id && !$0.fading }
    }

    private func nowMs() -> Int { Int((timelineSec * 1000).rounded()) }

    private func emitInject(_ line: InjectLine, _ state: String, positionMs: Int, atMs: Int) {
        writer.send(["type": "inject", "utteranceId": line.id, "state": state,
                     "positionMs": max(0, positionMs), "atMs": max(0, atMs)])
    }

    private func positionMs(_ line: InjectLine) -> Int { Int((line.mixedSec * 1000).rounded()) }

    /// Reports the cancel now with the position reached; the audible fade finishes in the mix.
    private func cancelLine(_ line: InjectLine, fadeMs: Int) {
        guard !line.fading else { return }
        emitInject(line, "cancelled", positionMs: positionMs(line), atMs: nowMs())
        spans.close(id: line.id, endMs: Int((timelineSec * 1000).rounded()) + 500)
        let rate = line.targetRate > 0 ? line.targetRate : (micFormat?.sampleRate ?? line.lineRate)
        let fadeFrames = Int(rate * Double(fadeMs) / 1000)
        if fadeFrames <= 0 || line.available == 0 {
            lines.removeAll { $0 === line }
        } else {
            line.fading = true
            line.fadeTotal = fadeFrames
            line.fadeLeft = fadeFrames
        }
    }

    private func floatBuffer(_ samples: ArraySlice<Float>, format: AVAudioFormat) -> AVAudioPCMBuffer? {
        guard let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(max(1, samples.count))),
              let channel = buffer.floatChannelData?[0] else { return nil }
        for (offset, value) in samples.enumerated() { channel[offset] = value }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        return buffer
    }

    private func append(_ buffer: AVAudioPCMBuffer, to line: InjectLine) {
        guard let channel = buffer.floatChannelData?[0], buffer.frameLength > 0 else { return }
        line.fifo.append(contentsOf: UnsafeBufferPointer(start: channel, count: Int(buffer.frameLength)))
    }

    /// Converts a flush of an AVAudioConverter (the samples it still holds back).
    private func flushed(_ converter: AVAudioConverter, to format: AVAudioFormat) -> AVAudioPCMBuffer? {
        guard let out = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: 4096) else { return nil }
        var conversionError: NSError?
        let status = converter.convert(to: out, error: &conversionError) { _, outStatus in
            outStatus.pointee = .endOfStream; return nil
        }
        guard conversionError == nil, status != .error else { return nil }
        return out
    }

    /// Converts what has arrived at the line's rate into the mic-rate FIFO. Waits (keeping the
    /// samples) until the first mic buffer says what the mic rate is; follows a mic rate change.
    private func convertPending(_ line: InjectLine, flush: Bool) {
        // inject-end can come before the first mic buffer: the flush is remembered and done once the mic rate is known.
        guard let target = micFormat else { if flush { line.flushOwed = true }; return }
        let flush = flush || line.flushOwed
        line.flushOwed = false
        if line.targetRate != target.sampleRate {
            retarget(line, to: target)
        }
        if line.read > 16_384 { line.fifo.removeFirst(line.read); line.read = 0 }
        if !line.pending.isEmpty {
            if line.lineRate == target.sampleRate {
                line.fifo.append(contentsOf: line.pending)
            } else if let source = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: line.lineRate,
                                                 channels: 1, interleaved: false) {
                if line.converter == nil {
                    line.converter = AVAudioConverter(from: source, to: target)
                    line.converter?.primeMethod = .none
                }
                if let converter = line.converter, let input = floatBuffer(line.pending[...], format: source),
                   let out = convert(input, with: converter, to: target) {
                    append(out, to: line)
                }
            }
            line.pending.removeAll(keepingCapacity: true)
        }
        if flush, line.lineRate != target.sampleRate, let converter = line.converter,
           let out = flushed(converter, to: target) {
            append(out, to: line)
        }
    }

    /// The mic rate changed (or became known): resample what is queued and rebuild the converter.
    private func retarget(_ line: InjectLine, to target: AVAudioFormat) {
        let oldRate = line.targetRate
        if oldRate > 0, line.available > 0,
           let oldFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: oldRate, channels: 1, interleaved: false),
           let converter = AVAudioConverter(from: oldFormat, to: target),
           let input = floatBuffer(line.fifo[line.read...], format: oldFormat),
           let out = convert(input, with: converter, to: target) {
            let tail = flushed(converter, to: target)
            line.fifo.removeAll(keepingCapacity: true); line.read = 0
            append(out, to: line)
            if let tail { append(tail, to: line) }
        } else if oldRate > 0 {
            line.fifo.removeAll(keepingCapacity: true); line.read = 0
        }
        line.converter = nil
        line.targetRate = target.sampleRate
    }

    /// Sums every line into the mono mic samples (clamped); reports started, position and finished.
    private func mixInjected(into samples: UnsafeMutablePointer<Float>, frames: Int, rate: Double, startSec: Double) {
        for line in lines { convertPending(line, flush: false) }
        let endSec = startSec + Double(frames) / rate
        for line in lines {
            let count = min(line.available, frames)
            if count > 0, !line.fading, !line.started {
                line.started = true
                let startMs = Int((startSec * 1000).rounded())
                spans.open(id: line.id, startMs: startMs)
                emitInject(line, "started", positionMs: 0, atMs: startMs)
            }
            for index in 0..<frames {
                var gain: Float = 1
                if line.fading {
                    guard line.fadeLeft > 0 else { break }
                    gain = Float(line.fadeLeft) / Float(line.fadeTotal)
                    line.fadeLeft -= 1
                }
                guard index < count else { if line.fading { continue } else { break } }
                let mixed = samples[index] + line.fifo[line.read + index] * gain
                samples[index] = min(1, max(-1, mixed))
            }
            line.read += count
            line.lastCount = count
            line.mixedSec += Double(count) / rate
        }
        // Retire lines: faded out, or finished (inject-end received and every sample mixed).
        var retired: [InjectLine] = []
        for line in lines {
            if line.fading {
                if line.fadeLeft <= 0 || line.available == 0 { retired.append(line) }
                continue
            }
            if line.ended, line.available == 0, line.pending.isEmpty {
                let finishedSec = startSec + Double(line.lastCount) / rate
                emitInject(line, "finished", positionMs: positionMs(line), atMs: Int((finishedSec * 1000).rounded()))
                spans.close(id: line.id, endMs: Int((endSec * 1000).rounded()) + 500)
                injectTailUntilSec = endSec + Self.injectTailSec
                retired.append(line)
            } else if line.started, endSec - line.lastPositionSec >= 0.04 {
                line.lastPositionSec = endSec
                emitInject(line, "position", positionMs: positionMs(line), atMs: Int((endSec * 1000).rounded()))
            }
        }
        if !retired.isEmpty { lines.removeAll { line in retired.contains { $0 === line } } }
    }

    /// Render-thread entry: copy channel 0 only, then hop to the serial queue.
    func ingest(_ buffer: AVAudioPCMBuffer) {
        let frames = Int(buffer.frameLength)
        guard frames > 0, let channel = buffer.floatChannelData?[0] else { return }
        let rate = buffer.format.sampleRate
        formatLock.lock()
        if monoFormat?.sampleRate != rate {
            monoFormat = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false)
        }
        let format = monoFormat
        formatLock.unlock()
        guard let format, let mono = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
              let destination = mono.floatChannelData?[0] else { return }
        destination.update(from: channel, count: frames)
        mono.frameLength = AVAudioFrameCount(frames)
        let arrival = ProcessInfo.processInfo.systemUptime
        queue.async { self.process(mono, arrival: arrival) }
    }

    /// Without microphone access: a silent mic signal of `frames` samples at 16 kHz goes through
    /// the very same processing, so an injected line still reaches the VAD, analyzer and WAV.
    func ingestSilence(frames: Int) {
        guard frames > 0, let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: 16_000,
                                                      channels: 1, interleaved: false),
              let mono = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
              let channel = mono.floatChannelData?[0] else { return }
        channel.update(repeating: 0, count: frames)
        mono.frameLength = AVAudioFrameCount(frames)
        let arrival = ProcessInfo.processInfo.systemUptime
        queue.async { self.process(mono, arrival: arrival) }
    }

    private func emitLevel() {
        guard !stopped else { return }
        // Nothing accumulates while muted with no injected line, so this reads 0 then.
        var rms = 0.0
        if levelCount > 0 { rms = min(1, (levelSumSquares / Double(levelCount)).squareRoot()) }
        levelSumSquares = 0; levelCount = 0
        writer.send(["type": "level", "rms": (rms * 1000).rounded() / 1000,
                     "atMs": Int((timelineSec * 1000).rounded())])
    }

    private func emitVad(_ speaking: Bool, atSec: Double) {
        writer.send(["type": "vad", "speaking": speaking, "atMs": max(0, Int((atSec * 1000).rounded()))])
    }

    private func convert(_ source: AVAudioPCMBuffer, with converter: AVAudioConverter,
                         to format: AVAudioFormat) -> AVAudioPCMBuffer? {
        let capacity = AVAudioFrameCount(ceil(Double(source.frameLength) * format.sampleRate / source.format.sampleRate) + 64)
        guard let converted = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: capacity) else { return nil }
        var supplied = false
        var conversionError: NSError?
        let status = converter.convert(to: converted, error: &conversionError) { _, outStatus in
            if supplied { outStatus.pointee = .noDataNow; return nil }
            supplied = true; outStatus.pointee = .haveData; return source
        }
        guard conversionError == nil, status != .error else { return nil }
        return converted
    }

    /// Keeps the WAV exactly on the timeline: pads or trims to the target length.
    private func alignWav(to targetSec: Double, samples: AVAudioPCMBuffer?) {
        let target = Int64((targetSec * Double(WavWriter.sampleRate)).rounded())
        var needed = Int(max(0, target - wav.frames))
        do {
            if let samples, let data = samples.int16ChannelData?[0], needed > 0 {
                let count = min(Int(samples.frameLength), needed)
                try wav.append(data, count: count)
                needed -= count
            }
            try wav.appendSilence(frames: needed)
        } catch { fail("recording-failed") }
    }

    /// Muted: the raw signal is only measured, to tell when the candidate seems to be talking into a muted mic (as a
    /// meeting app does). One `muted-speech` per run of speech that lasts `mutedSpeechMs`; nothing else leaves here.
    private func detectMutedSpeech(_ samples: UnsafeMutablePointer<Float>, frames: Int, rate: Double, startSec: Double) {
        let windowFrames = max(1, Int(rate * PracticeVadTuning.windowMs / 1000))
        var index = 0
        while index < frames {
            let count = min(windowFrames, frames - index)
            var sum: Float = 0
            for i in index..<(index + count) { sum += samples[i] * samples[i] }
            let windowMs = Double(count) / rate * 1000
            let startMs = (startSec + Double(index) / rate) * 1000
            if let change = mutedVad.process(rms: (sum / Float(count)).squareRoot(), startMs: startMs, durationMs: windowMs) {
                mutedRunMs = 0
                if !change.speaking { mutedRunReported = false }
            }
            if mutedVad.speaking, !mutedRunReported {
                mutedRunMs += windowMs
                if mutedRunMs >= Self.mutedSpeechMs {
                    mutedRunReported = true
                    writer.send(["type": "muted-speech", "atMs": max(0, Int(startMs.rounded()))])
                }
            }
            index += count
        }
    }

    private func process(_ mono: AVAudioPCMBuffer, arrival: TimeInterval) {
        guard !stopped else { return }
        let rate = mono.format.sampleRate
        let frames = Int(mono.frameLength)
        guard rate > 0, frames > 0 else { return }
        let duration = Double(frames) / rate
        if interrupted {
            interrupted = false
            if let last = lastArrival {
                let gap = min(max(0, (arrival - duration) - last), 120)
                if vad.speaking { emitVad(false, atSec: timelineSec) }
                vad.reset()
                timelineSec += gap
                alignWav(to: timelineSec, samples: nil)
            }
            analyzerNeedsStart = true
            analyzerConverter = nil; wavConverter = nil; sourceRate = 0
        }
        lastArrival = arrival
        if rate != sourceRate || wavConverter == nil || (analyzerFormat != nil && analyzerConverter == nil) {
            sourceRate = rate
            if let analyzerFormat {
                analyzerConverter = AVAudioConverter(from: mono.format, to: analyzerFormat)
                analyzerConverter?.primeMethod = .none
            }
            wavConverter = AVAudioConverter(from: mono.format, to: wavFormat)
            wavConverter?.primeMethod = .none
        }
        if micFormat?.sampleRate != rate { micFormat = mono.format }
        let startSec = timelineSec
        timelineSec += duration
        // A muted mic is zeroed; an injected line still goes through everything below.
        let mixing = !lines.isEmpty || startSec < injectTailUntilSec
        if muted, let samples = mono.floatChannelData?[0] {
            detectMutedSpeech(samples, frames: frames, rate: rate, startSec: startSec)
            samples.update(repeating: 0, count: frames)
        }
        if mixing, let samples = mono.floatChannelData?[0] {
            mixInjected(into: samples, frames: frames, rate: rate, startSec: startSec)
        }
        // Muted with nothing injected: the zeroed signal still goes through to the analyzer. The recogniser only
        // closes a segment once it hears the silence after it, so stopping the feed here left the last sentence of an
        // AI-voice line unfinished until the mic was unmuted or the next line played, and the interviewer waited on it
        // (found 2026-11-21). Zeros never trip the VAD, and transcripts outside an injected line are dropped while muted.
        if muted, !mixing, vad.speaking { emitVad(false, atSec: startSec); vad.reset() }
        // Level and VAD in ~10 ms windows.
        if let samples = mono.floatChannelData?[0] {
            let windowFrames = max(1, Int(rate * PracticeVadTuning.windowMs / 1000))
            var index = 0
            while index < frames {
                let count = min(windowFrames, frames - index)
                var sum: Float = 0
                for i in index..<(index + count) { sum += samples[i] * samples[i] }
                levelSumSquares += Double(sum); levelCount += count
                let windowRms = (sum / Float(count)).squareRoot()
                let windowStartMs = (startSec + Double(index) / rate) * 1000
                if let change = vad.process(rms: windowRms, startMs: windowStartMs,
                                            durationMs: Double(count) / rate * 1000) {
                    emitVad(change.speaking, atSec: change.atMs / 1000)
                }
                index += count
            }
        }
        guard let wavConverter else { fail("capture-failed"); return }
        guard let forWav = convert(mono, with: wavConverter, to: wavFormat) else {
            fail("capture-failed"); return
        }
        if let analyzerFormat, let input {
            guard let analyzerConverter, let forAnalyzer = convert(mono, with: analyzerConverter, to: analyzerFormat) else {
                fail("capture-failed"); return
            }
            if forAnalyzer.frameLength > 0 {
                let item: AnalyzerInput
                if analyzerNeedsStart {
                    analyzerNeedsStart = false
                    item = AnalyzerInput(buffer: forAnalyzer, bufferStartTime:
                        CMTime(value: Int64((startSec * 1_000_000).rounded()), timescale: 1_000_000))
                } else {
                    item = AnalyzerInput(buffer: forAnalyzer)
                }
                if case .dropped = input.yield(item) { fail("recognition-failed") } // Never silently lose speech.
            }
        }
        alignWav(to: timelineSec, samples: forWav)
        clock.publish(endSec: timelineSec, arrival: arrival)
    }
}

/// Stands in for the microphone when access is denied: the call still runs and the candidate
/// is simply not heard. A silent 16 kHz signal is fed through the same MicProcessor a real
/// microphone uses, so the timeline, the level events and the recording length keep moving
/// exactly as with a silent microphone and an injected line (the candidate's AI voice) still
/// goes through the VAD, the analyzer and the recording.
final class SilentMic: @unchecked Sendable {
    private let queue = DispatchQueue(label: "practice-audio.silent-mic", qos: .userInitiated)
    private let processor: MicProcessor
    private var timer: DispatchSourceTimer?
    private var startedAt: TimeInterval = 0
    private var produced: Int64 = 0
    private var stopped = false

    init(processor: MicProcessor) { self.processor = processor }

    func start() {
        queue.async {
            guard !self.stopped, self.timer == nil else { return }
            self.startedAt = ProcessInfo.processInfo.systemUptime
            let timer = DispatchSource.makeTimerSource(queue: self.queue)
            timer.schedule(deadline: .now() + .milliseconds(20), repeating: .milliseconds(20))
            // Retained until stop() cancels the timer.
            timer.setEventHandler { self.tick() }
            self.timer = timer
            timer.resume()
        }
    }

    private func tick() {
        guard !stopped else { return }
        let seconds = max(0, ProcessInfo.processInfo.systemUptime - startedAt)
        let target = Int64((seconds * 16_000).rounded())
        let frames = Int(max(0, target - produced))
        guard frames > 0 else { return }
        produced += Int64(frames)
        processor.ingestSilence(frames: frames)
    }

    func stop() async {
        await withCheckedContinuation { continuation in
            queue.async {
                // The recording runs to the moment the call stopped, like a microphone's would.
                if !self.stopped { self.tick() }
                self.stopped = true
                self.timer?.cancel(); self.timer = nil
                continuation.resume()
            }
        }
    }
}

/// Plays utterances on a player node attached to the SHARED engine's main
/// mixer, so voice processing sees the playback as its echo reference.
@MainActor final class PlaybackController {
    private struct Utterance {
        let id: String
        let rate: Double
        let generation: Int
        var scheduledFrames: Int64 = 0
        var pending = 0
        var ended = false
        var started = false
        var offsetSec = 0.0
        var carry: UInt8?
        var lastPositionAt: TimeInterval = 0
        var paused = false
        var pausedPositionMs = 0
    }

    private let engine: AVAudioEngine
    private let player = AVAudioPlayerNode()
    private let writer: ProtocolWriter
    private let clock: TimelineClock
    private let fail: (String) -> Void
    private var active: Utterance?
    private var generation = 0
    private var connectedRate = 0.0
    private var timer: DispatchSourceTimer?
    private static let maxSecondsPerUtterance = 600.0

    init(engine: AVAudioEngine, writer: ProtocolWriter, clock: TimelineClock, fail: @escaping (String) -> Void) {
        self.engine = engine; self.writer = writer; self.clock = clock; self.fail = fail
    }

    /// Attach and connect before the engine starts (voice processing already on).
    func attach() {
        engine.attach(player)
        connect(rate: 24_000)
    }

    /// Re-establish the connection after an engine restart.
    func reconnect() {
        player.stop()
        connect(rate: connectedRate > 0 ? connectedRate : 24_000)
    }

    private func connect(rate: Double) {
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false) else { return }
        engine.disconnectNodeOutput(player)
        engine.connect(player, to: engine.mainMixerNode, format: format)
        connectedRate = rate
    }

    func startTimer() {
        guard timer == nil else { return }
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now(), repeating: .milliseconds(10), leeway: .milliseconds(2))
        timer.setEventHandler { [weak self] in Task { @MainActor in self?.tick() } }
        self.timer = timer
        timer.resume()
    }

    func play(id: String, sampleRate: Int) {
        cancelActive()
        let rate = Double(sampleRate)
        guard engine.isRunning else { fail("playback-failed"); return }
        player.stop() // The player's sample clock restarts at 0 on stop/play.
        if connectedRate != rate { connect(rate: rate) }
        generation += 1
        active = Utterance(id: id, rate: rate, generation: generation)
    }

    func audio(id: String, pcm: Data) {
        guard var utterance = active, utterance.id == id, !utterance.ended else { return }
        var bytes = [UInt8]()
        bytes.reserveCapacity(pcm.count + 1)
        if let carry = utterance.carry { bytes.append(carry); utterance.carry = nil }
        bytes.append(contentsOf: pcm)
        if bytes.count % 2 == 1 { utterance.carry = bytes.removeLast() }
        let frames = bytes.count / 2
        guard frames > 0 else { active = utterance; return }
        guard Double(utterance.scheduledFrames + Int64(frames)) / utterance.rate <= Self.maxSecondsPerUtterance,
              let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: utterance.rate, channels: 1, interleaved: false),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
              let channel = buffer.floatChannelData?[0] else { active = utterance; return }
        for index in 0..<frames {
            let sample = Int16(bitPattern: UInt16(bytes[index * 2]) | (UInt16(bytes[index * 2 + 1]) << 8))
            channel[index] = Float(sample) / 32768
        }
        buffer.frameLength = AVAudioFrameCount(frames)
        // If the player ran dry, its clock kept counting silence: exclude it.
        if utterance.started, !utterance.paused, let now = renderSeconds() {
            let scheduledSec = Double(utterance.scheduledFrames) / utterance.rate
            if now - utterance.offsetSec > scheduledSec { utterance.offsetSec = now - scheduledSec }
        }
        utterance.scheduledFrames += Int64(frames)
        utterance.pending += 1
        let token = utterance.generation
        active = utterance
        player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in self?.bufferPlayed(token) }
        }
        // While paused, newly scheduled buffers wait silently for `resume`.
        if !player.isPlaying, !utterance.paused {
            guard engine.isRunning else { fail("playback-failed"); return }
            player.play()
        }
    }

    func end(id: String) {
        guard var utterance = active, utterance.id == id else { return }
        utterance.ended = true
        active = utterance
        if utterance.pending == 0 { finishActive() }
    }

    func cancel(id: String) {
        guard let utterance = active, utterance.id == id else { return }
        cancelActive()
    }

    /// Silence the active utterance immediately; scheduled buffers and the
    /// player's sample clock are kept, so `resume` continues at the same sample.
    func pause(id: String) {
        guard var utterance = active, utterance.id == id, !utterance.paused else { return }
        let position = positionMs(utterance)
        utterance.paused = true
        utterance.pausedPositionMs = position
        active = utterance
        player.pause()
        emit(utterance.id, "paused", position)
    }

    /// Continue from the paused sample. The clock did not advance while paused,
    /// so no dry-run offset correction is needed here.
    func resume(id: String) {
        guard var utterance = active, utterance.id == id, utterance.paused else { return }
        guard engine.isRunning else { fail("playback-failed"); return }
        let position = utterance.pausedPositionMs
        utterance.paused = false
        utterance.lastPositionAt = ProcessInfo.processInfo.systemUptime
        active = utterance
        player.play()
        emit(utterance.id, "resumed", position)
    }

    /// Stops audio immediately (within one render cycle) and reports the played position.
    func cancelActive() {
        guard let utterance = active else { return }
        let position = positionMs(utterance)
        active = nil
        player.stop()
        player.reset()
        emit(utterance.id, "cancelled", position)
    }

    func shutdown() {
        timer?.cancel(); timer = nil
        cancelActive()
        player.stop()
    }

    private func bufferPlayed(_ token: Int) {
        guard var utterance = active, utterance.generation == token else { return }
        utterance.pending = max(0, utterance.pending - 1)
        active = utterance
        if utterance.pending == 0, utterance.ended { finishActive() }
    }

    private func finishActive() {
        guard let utterance = active else { return }
        active = nil
        let total = Int((Double(utterance.scheduledFrames) / utterance.rate * 1000).rounded())
        player.stop()
        emit(utterance.id, "finished", total)
    }

    private func renderSeconds() -> Double? {
        guard player.isPlaying, let nodeTime = player.lastRenderTime,
              let playerTime = player.playerTime(forNodeTime: nodeTime),
              playerTime.isSampleTimeValid, playerTime.sampleRate > 0 else { return nil }
        return Double(playerTime.sampleTime) / playerTime.sampleRate
    }

    private func positionMs(_ utterance: Utterance) -> Int {
        // Paused: the player's clock is frozen, so report the recorded position.
        if utterance.paused { return utterance.pausedPositionMs }
        guard utterance.started || utterance.scheduledFrames > 0, let now = renderSeconds() else { return 0 }
        let total = Double(utterance.scheduledFrames) / utterance.rate
        let seconds = min(max(now - utterance.offsetSec, 0), total)
        return Int((seconds * 1000).rounded())
    }

    private func emit(_ id: String, _ state: String, _ positionMs: Int) {
        writer.send(["type": "playback", "utteranceId": id, "state": state,
                     "positionMs": positionMs, "atMs": clock.nowMs()])
    }

    private func tick() {
        // No position events while paused; positionMs stays at the paused value.
        guard var utterance = active, !utterance.paused, let now = renderSeconds(), now > 0 else { return }
        let uptime = ProcessInfo.processInfo.systemUptime
        if !utterance.started {
            utterance.started = true; utterance.lastPositionAt = uptime
            active = utterance
            emit(utterance.id, "started", positionMs(utterance))
        } else if uptime - utterance.lastPositionAt >= 0.05 {
            utterance.lastPositionAt = uptime
            active = utterance
            emit(utterance.id, "position", positionMs(utterance))
        }
    }
}

/// What the candidate hears of an injected line: separate player nodes on the SHARED engine's
/// main mixer (so voice processing has the sound as echo reference and the real microphone does
/// not pick it back up). Independent of the interviewer's PlaybackController, so both can sound
/// at once. The monitor is audio only: it reports nothing and its failures are never fatal,
/// because the line itself reaches the app through the mic signal.
@MainActor final class InjectMonitor {
    private final class Slot {
        let player = AVAudioPlayerNode()
        var connectedRate = 0.0
        var id: String?
        var rate = 0.0
        var generation = 0
        var pending = 0
        var ended = false
        var fading = false
        var carry: UInt8?
        var fadeTimer: DispatchSourceTimer?
    }

    private let engine: AVAudioEngine
    private let slots: [Slot] = (0..<3).map { _ in Slot() }
    private static let maxSecondsPerLine = 600.0

    init(engine: AVAudioEngine) { self.engine = engine }

    /// Attach and connect before the engine starts.
    func attach() {
        for slot in slots { engine.attach(slot.player); connect(slot, rate: 24_000) }
    }

    /// Re-establish the connections after an engine restart (queued buffers are gone).
    func reconnect() {
        for slot in slots {
            release(slot)
            connect(slot, rate: slot.connectedRate > 0 ? slot.connectedRate : 24_000)
        }
    }

    private func connect(_ slot: Slot, rate: Double) {
        guard let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: rate, channels: 1, interleaved: false) else { return }
        engine.disconnectNodeOutput(slot.player)
        engine.connect(slot.player, to: engine.mainMixerNode, format: format)
        slot.connectedRate = rate
    }

    /// Stops a slot at once and frees it.
    private func release(_ slot: Slot) {
        slot.fadeTimer?.cancel(); slot.fadeTimer = nil
        slot.generation += 1
        slot.player.stop(); slot.player.reset()
        slot.player.volume = 1
        slot.id = nil; slot.fading = false; slot.ended = false; slot.pending = 0; slot.carry = nil
    }

    private func fadeOut(_ slot: Slot, ms: Int) {
        guard slot.id != nil, !slot.fading else { return }
        guard ms > 0 else { release(slot); return }
        slot.fading = true
        let steps = max(1, ms / 10)
        var step = 0
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now(), repeating: .milliseconds(10))
        let token = slot.generation
        timer.setEventHandler { [weak self, weak slot] in
            Task { @MainActor in
                guard let self, let slot, slot.generation == token else { return }
                step += 1
                if step >= steps { self.release(slot) }
                else { slot.player.volume = max(0, 1 - Float(step) / Float(steps)) }
            }
        }
        slot.fadeTimer = timer
        timer.resume()
    }

    func start(id: String, sampleRate: Int) {
        for slot in slots where slot.id != nil && !slot.fading { fadeOut(slot, ms: 30) }
        guard engine.isRunning else { return }
        let slot = slots.first { $0.id == nil && !$0.fading }
            ?? slots.first { $0.fading }   // all busy: the oldest fade ends now
        guard let slot else { return }
        if slot.fading || slot.id != nil { release(slot) }
        let rate = Double(sampleRate)
        slot.player.stop()
        if slot.connectedRate != rate { connect(slot, rate: rate) }
        slot.id = id; slot.rate = rate; slot.ended = false; slot.pending = 0; slot.carry = nil
        slot.generation += 1
    }

    func audio(id: String, pcm: Data) {
        guard let index = slots.firstIndex(where: { $0.id == id && !$0.fading && !$0.ended }) else { return }
        let slot = slots[index]
        var bytes = [UInt8]()
        bytes.reserveCapacity(pcm.count + 1)
        if let carry = slot.carry { bytes.append(carry); slot.carry = nil }
        bytes.append(contentsOf: pcm)
        if bytes.count % 2 == 1 { slot.carry = bytes.removeLast() }
        let frames = bytes.count / 2
        guard frames > 0, engine.isRunning,
              let format = AVAudioFormat(commonFormat: .pcmFormatFloat32, sampleRate: slot.rate, channels: 1, interleaved: false),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(frames)),
              let channel = buffer.floatChannelData?[0] else { return }
        for i in 0..<frames {
            let sample = Int16(bitPattern: UInt16(bytes[i * 2]) | (UInt16(bytes[i * 2 + 1]) << 8))
            channel[i] = Float(sample) / 32768
        }
        buffer.frameLength = AVAudioFrameCount(frames)
        slot.pending += 1
        let token = slot.generation
        slot.player.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in self?.bufferPlayed(index, token) }
        }
        if !slot.player.isPlaying { slot.player.play() }
    }

    func end(id: String) {
        guard let slot = slots.first(where: { $0.id == id && !$0.fading }) else { return }
        slot.ended = true
        if slot.pending == 0 { release(slot) }
    }

    func cancel(id: String, fadeMs: Int) {
        guard let slot = slots.first(where: { $0.id == id && !$0.fading }) else { return }
        fadeOut(slot, ms: fadeMs)
    }

    func cancelAll() { for slot in slots { release(slot) } }

    func shutdown() { cancelAll() }

    private func bufferPlayed(_ index: Int, _ token: Int) {
        let slot = slots[index]
        guard slot.generation == token else { return }
        slot.pending = max(0, slot.pending - 1)
        if slot.pending == 0, slot.ended, !slot.fading { release(slot) }
    }
}

@available(macOS 26.0, *)
@MainActor final class PracticeSession {
    private let parentPID: pid_t
    private let locale: Locale
    private let writer: ProtocolWriter
    private let wav: WavWriter
    private let finish: AsyncStream<String>.Continuation
    /// Replaced, never reused, when the microphone is dropped or reconnected: an engine whose input
    /// node was touched keeps asking for that device, so a call without one runs on a fresh engine.
    private var engine = AVAudioEngine()
    private let clock = TimelineClock()
    private var playback: PlaybackController?
    private var injectMonitor: InjectMonitor?
    private let injectSpans = InjectSpans()
    private var hasMicrophone = false
    private var mic: MicProcessor?
    private var silentMic: SilentMic?
    private var analyzer: SpeechAnalyzer?
    private var resultsTask: Task<Void, Never>?
    private var parentTimer: DispatchSourceTimer?
    private var configObserver: NSObjectProtocol?
    private var stopped = false
    private var muted = false
    /// When the engine was last restarted after a configuration change (device switches come in bursts).
    private var restartTimes: [TimeInterval] = []
    /// The microphone stopped working during this call (not refused): the call runs on silence until it is reconnected.
    private var microphoneFailed = false
    private var reconnecting = false
    private static let restartsPerWindow = 4
    private static let restartWindowSec = 10.0

    init(parentPID: pid_t, locale: Locale, writer: ProtocolWriter, wav: WavWriter,
         finish: AsyncStream<String>.Continuation) {
        self.parentPID = parentPID; self.locale = locale; self.writer = writer
        self.wav = wav; self.finish = finish
    }

    func handle(_ command: Command) {
        guard !stopped else { return }
        switch command {
        case .play(let id, let rate): playback?.play(id: id, sampleRate: rate)
        case .audio(let id, let pcm): playback?.audio(id: id, pcm: pcm)
        case .end(let id): playback?.end(id: id)
        case .cancel(let id): playback?.cancel(id: id)
        case .pause(let id): playback?.pause(id: id)
        case .resume(let id): playback?.resume(id: id)
        case .mute(let value): muted = value; mic?.setMuted(value)
        case .inject(let id, let rate):
            mic?.injectStart(id: id, sampleRate: rate); injectMonitor?.start(id: id, sampleRate: rate)
        case .injectAudio(let id, let pcm):
            mic?.injectAudio(id: id, pcm: pcm); injectMonitor?.audio(id: id, pcm: pcm)
        case .injectEnd(let id): mic?.injectEnd(id: id); injectMonitor?.end(id: id)
        case .injectCancel(let id, let fadeMs):
            mic?.injectCancel(id: id, fadeMs: fadeMs); injectMonitor?.cancel(id: id, fadeMs: fadeMs)
        case .reconnectMicrophone: Task { await reconnectMicrophone() }
        case .stop: finish.yield("stopped")
        }
    }

    func start() async {
        writer.send(["type": "status", "state": "preparing"])
        do {
            // Microphone permission strictly before the engine starts. Without it the call
            // runs unheard: no capture, no transcription, and none of their set-up.
            let granted = await withCheckedContinuation { (continuation: CheckedContinuation<Bool, Never>) in
                AVCaptureDevice.requestAccess(for: .audio) { continuation.resume(returning: $0) }
            }
            try Task.checkCancellation()
            guard !stopped else { return }
            guard granted else { try await startWithoutMicrophone(); return }

            let prepared = try await prepareAnalysis()
            try Task.checkCancellation()
            guard !stopped else { return }

            let continuation = try await startAnalysis(prepared)
            try Task.checkCancellation()
            guard !stopped else { return }
            let micProcessor = makeMicProcessor(format: prepared.format, input: continuation)
            let playbackController: PlaybackController
            do { playbackController = try buildEngine(microphone: true) }
            catch {
                // The microphone would not start. The call still goes ahead, as it does without microphone
                // access: the interviewer is heard, the candidate can type or reconnect from the call window.
                let silent = try startSilentEngine(after: "microphone start", processor: micProcessor)
                micProcessor.startLevelTimer()
                engineStarted(silent)
                return
            }
            micProcessor.startLevelTimer()
            engineStarted(playbackController)
        } catch is CancellationError {
            finish.yield("stopped")
        } catch let failure as HelperFailure { fail(failure.code) }
        catch { diagnose("start", error); fail("capture-failed") }
    }

    /// The engine is running: watch it and the parent, then report ready.
    private func engineStarted(_ playbackController: PlaybackController) {
        watchEngine(playbackController)
        let timer = DispatchSource.makeTimerSource(queue: .main)
        timer.schedule(deadline: .now() + .seconds(1), repeating: .seconds(1))
        timer.setEventHandler { [weak self] in
            Task { @MainActor in
                guard let self else { return }
                if Darwin.kill(self.parentPID, 0) != 0 && errno != EPERM { self.finish.yield("parent-exited") }
            }
        }
        parentTimer = timer; timer.resume()
        // microphone false: access was refused and a silent signal stands in, so the call can say so.
        writer.send(["type": "status", "state": "ready", "inject": true, "microphone": hasMicrophone])
    }

    /// Follows the running engine's configuration changes and starts the playback clock. Again after each new engine.
    private func watchEngine(_ playbackController: PlaybackController) {
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        configObserver = NotificationCenter.default.addObserver(
            forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main) { [weak self] _ in
            Task { @MainActor in self?.engineConfigurationChanged() }
        }
        playbackController.startTimer()
    }

    /// Builds the graph on the current (fresh) engine and starts it, with or without the microphone.
    /// On failure the input tap is gone again and the error says which side failed.
    private func buildEngine(microphone: Bool) throws -> PlaybackController {
        // Voice processing (echo cancellation) must be on before anything
        // is attached or started. Never capture without it.
        // The output side of the graph must exist before voice processing is switched on,
        // and the mixer must be joined to the output explicitly afterwards (below). With the
        // implicit connection the engine refuses to start (-10875 on the output unit); measured
        // on macOS 27.2: 0 of 6 starts as it was, 6 of 6 with either step, so both are done.
        _ = engine.outputNode
        _ = engine.mainMixerNode
        if microphone {
            do { try engine.inputNode.setVoiceProcessingEnabled(true) }
            catch { diagnose("voice processing", error); throw HelperFailure.code("capture-failed") }
        }
        let playbackController = makePlayback()
        playbackController.attach()
        injectMonitor?.attach()
        connectMixerToOutput()
        if microphone {
            // No input device (unplugged, nothing built in): tapping a 0-channel input raises an Objective-C exception
            // that would take the whole helper down, so it counts as a failed microphone instead.
            guard inputUsable() else { throw HelperFailure.code("capture-failed") }
            hasMicrophone = true; installTap()
        }
        engine.prepare()
        do { try engine.start() } catch {
            diagnose("engine start", error)
            if hasMicrophone { engine.inputNode.removeTap(onBus: 0); hasMicrophone = false }
            throw HelperFailure.code(microphone ? "capture-failed" : "playback-failed")
        }
        return playbackController
    }

    /// Stops and drops the running graph; the next one is built on a fresh engine.
    private func tearDownEngine() {
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        configObserver = nil
        playback?.shutdown(); playback = nil
        injectMonitor?.shutdown(); injectMonitor = nil
        if hasMicrophone { engine.inputNode.removeTap(onBus: 0) }
        hasMicrophone = false
        engine.stop()
        engine = AVAudioEngine()
    }

    /// The microphone failed: the graph is rebuilt without it and a silent signal stands in, so the
    /// call goes on (the interviewer heard, the timeline and recording moving) and the call window
    /// can say so and offer to reconnect. Throws playback-failed when even that will not start.
    private func startSilentEngine(after step: String, processor: MicProcessor) throws -> PlaybackController {
        FileHandle.standardError.write(Data("practice-audio-helper: microphone failed (\(step)), running without capture\n".utf8))
        microphoneFailed = true
        // The tap goes first: a buffer it already sent is then processed before the interruption mark, and the
        // first silent buffer carries the whole gap (the rebuild included) into the timeline and the recording.
        tearDownEngine()
        processor.markInterruption()
        processor.injectCancelAll()
        // The engine without a microphone gets its own restart budget; the burst that dropped the mic is not held against it.
        restartTimes.removeAll()
        let playbackController = try buildEngine(microphone: false)
        let silent = SilentMic(processor: processor)
        silentMic = silent
        silent.start()
        writer.send(["type": "status", "state": "microphone", "available": false, "reason": "failed"])
        return playbackController
    }

    /// The microphone stopped working mid-call (a device change it could not survive, or its audio
    /// could not be converted): carry on without it rather than end the call.
    private func microphoneLost(_ step: String) {
        guard !stopped, !reconnecting else { return }
        // Already running on silence: a late failure from the old microphone's buffers changes nothing.
        guard hasMicrophone, let mic else { if !microphoneFailed { fail("capture-failed") }; return }
        do { watchEngine(try startSilentEngine(after: step, processor: mic)) } catch { fail("playback-failed") }
    }

    /// The candidate pressed Reconnect: try the microphone again on a fresh engine. Success swaps
    /// the silent stand-in for the microphone; failure leaves the call on silence as it was.
    private func reconnectMicrophone() async {
        guard !stopped, !reconnecting, let mic else { return }
        // Every request is answered, so the call window never waits on a reconnect that is not happening.
        guard !hasMicrophone else { writer.send(["type": "status", "state": "microphone", "available": true]); return }
        // Without access, or without a recogniser to hear it, a microphone would change nothing.
        guard AVCaptureDevice.authorizationStatus(for: .audio) == .authorized else {
            writer.send(["type": "status", "state": "microphone", "available": false, "reason": "denied"]); return
        }
        // Recognition could not be set up when this call began (no access and no speech assets then): a microphone
        // now would still not be understood, and only a new call can prepare it.
        guard mic.recognizes else { writer.send(["type": "status", "state": "microphone", "available": false, "reason": "rejoin"]); return }
        reconnecting = true
        defer { reconnecting = false }
        let silent = silentMic
        silentMic = nil
        await silent?.stop() // Its last silence reaches the processor first, so the timeline has no hole.
        guard !stopped else { return }
        mic.markInterruption()
        mic.injectCancelAll()
        tearDownEngine()
        do {
            let playbackController = try buildEngine(microphone: true)
            microphoneFailed = false
            restartTimes.removeAll()
            watchEngine(playbackController)
            writer.send(["type": "status", "state": "microphone", "available": true])
        } catch {
            do { watchEngine(try startSilentEngine(after: "reconnect", processor: mic)) } catch { fail("playback-failed") }
        }
    }

    /// Speech recognition set-up, shared by both paths: on-device assets are checked and the
    /// analyzer is prepared. Throws a HelperFailure code on failure.
    /// allowDownload false (no microphone): use the speech assets only if they are already installed, so a call
    /// without microphone access never waits on a download before it is ready.
    private func prepareAnalysis(allowDownload: Bool = true) async throws -> (transcriber: SpeechTranscriber, analyzer: SpeechAnalyzer, format: AVAudioFormat) {
        guard SpeechTranscriber.isAvailable,
              let supportedLocale = await SpeechTranscriber.supportedLocale(equivalentTo: locale) else {
            throw HelperFailure.code("unsupported-locale")
        }
        let transcriber = SpeechTranscriber(locale: supportedLocale, transcriptionOptions: [],
            reportingOptions: [.volatileResults, .fastResults], attributeOptions: [])
        // Only language-model assets may be downloaded.
        if await AssetInventory.status(forModules: [transcriber]) != .installed {
            guard allowDownload else { throw HelperFailure.code("speech-assets") }
            do {
                if let install = try await AssetInventory.assetInstallationRequest(supporting: [transcriber]) {
                    try await install.downloadAndInstall()
                } else if await AssetInventory.status(forModules: [transcriber]) != .installed {
                    throw HelperFailure.code("speech-assets")
                }
            } catch { throw HelperFailure.code("speech-assets") }
        }
        try Task.checkCancellation()
        guard !stopped, await AssetInventory.status(forModules: [transcriber]) == .installed,
              let format = await SpeechAnalyzer.bestAvailableAudioFormat(compatibleWith: [transcriber]) else {
            throw HelperFailure.code("speech-assets")
        }
        let analyzer = SpeechAnalyzer(modules: [transcriber], options: .init(priority: .userInitiated, modelRetention: .whileInUse))
        self.analyzer = analyzer
        try await analyzer.prepareToAnalyze(in: format)
        try Task.checkCancellation()
        guard !stopped else { throw CancellationError() }
        return (transcriber, analyzer, format)
    }

    /// Feeds the analyzer from a stream the MicProcessor writes to, and forwards its results.
    private func startAnalysis(_ prepared: (transcriber: SpeechTranscriber, analyzer: SpeechAnalyzer, format: AVAudioFormat))
        async throws -> AsyncStream<AnalyzerInput>.Continuation {
        let transcriber = prepared.transcriber
        let (inputs, continuation) = AsyncStream<AnalyzerInput>.makeStream(bufferingPolicy: .bufferingNewest(100))
        resultsTask = Task { [weak self] in
            do {
                for try await result in transcriber.results {
                    guard let self, !self.stopped, !Task.isCancelled else { return }
                    let text = String(result.text.characters).trimmingCharacters(in: .whitespacesAndNewlines)
                    guard !text.isEmpty else { continue }
                    guard text.count <= 4000 else { self.fail("recognition-failed"); return }
                    let start = result.range.start.seconds
                    let end = CMTimeRangeGetEnd(result.range).seconds
                    guard start.isFinite, end.isFinite, start >= 0, end >= start,
                          end < Double(Int.max / 1000) else { self.fail("recognition-failed"); return }
                    let startMs = Int((start * 1000).rounded())
                    let endMs = Int((end * 1000).rounded())
                    // A muted mic is silent, except where an injected line was mixed in.
                    guard !self.muted || self.injectSpans.overlaps(startMs: startMs, endMs: endMs) else { continue }
                    self.writer.send(["type": "transcript", "text": text, "segmentId": String(startMs),
                        "final": result.isFinal, "startMs": startMs, "endMs": endMs])
                }
            } catch { if !Task.isCancelled { self?.fail("recognition-failed") } }
        }
        try await prepared.analyzer.start(inputSequence: inputs)
        return continuation
    }

    private func makeMicProcessor(format: AVAudioFormat?, input: AsyncStream<AnalyzerInput>.Continuation?) -> MicProcessor {
        let processor = MicProcessor(analyzerFormat: format, input: input, writer: writer, wav: wav,
                                     clock: clock, spans: injectSpans) { [weak self] code in
            // A microphone whose audio cannot be converted is dropped, not the call.
            Task { @MainActor in if code == "capture-failed" { self?.microphoneLost("conversion") } else { self?.fail(code) } }
        }
        mic = processor
        return processor
    }

    private func makePlayback() -> PlaybackController {
        let controller = PlaybackController(engine: engine, writer: writer, clock: clock) { [weak self] code in
            self?.fail(code)
        }
        playback = controller
        injectMonitor = InjectMonitor(engine: engine)
        return controller
    }

    /// Microphone access was refused. The interviewer is still played and the candidate can
    /// type; the input node is never touched, so nothing here can ask for the microphone.
    /// A silent signal still goes through the MicProcessor (VAD, analyzer when its assets are
    /// available, recording), so a line injected in the candidate's AI voice works as with a mic.
    private func startWithoutMicrophone() async throws {
        FileHandle.standardError.write(Data("practice-audio-helper: no microphone access, running without capture\n".utf8))
        var format: AVAudioFormat?
        var continuation: AsyncStream<AnalyzerInput>.Continuation?
        do {
            let prepared = try await prepareAnalysis(allowDownload: false)
            try Task.checkCancellation()
            guard !stopped else { return }
            continuation = try await startAnalysis(prepared)
            format = prepared.format
        } catch is CancellationError {
            throw CancellationError()
        } catch {
            // Recognition is optional here: the call still runs, the line is just not transcribed.
            diagnose("speech recognition (no microphone)", error)
            resultsTask?.cancel(); resultsTask = nil
            await analyzer?.cancelAndFinishNow(); analyzer = nil
            format = nil; continuation = nil
        }
        try Task.checkCancellation()
        guard !stopped else { return }
        let micProcessor = makeMicProcessor(format: format, input: continuation)
        let playbackController = try buildEngine(microphone: false)
        let silent = SilentMic(processor: micProcessor)
        silentMic = silent
        micProcessor.startLevelTimer()
        silent.start()
        engineStarted(playbackController)
    }

    /// Which step failed and the system's own error, on stderr. The protocol on stdout only
    /// carries a code, and without this a failed start cannot be told apart from any other.
    /// The text is the framework's error description: no speech, transcript or path.
    private func diagnose(_ step: String, _ error: Error) {
        let line = "practice-audio-helper: \(step) failed: \(error)\n"
        FileHandle.standardError.write(Data(line.utf8))
    }

    private func connectMixerToOutput() {
        engine.connect(engine.mainMixerNode, to: engine.outputNode, format: engine.outputNode.inputFormat(forBus: 0))
    }

    /// Whether the engine's input has a real format (a device with channels and a rate).
    private func inputUsable() -> Bool {
        let format = engine.inputNode.inputFormat(forBus: 0)
        return format.channelCount > 0 && format.sampleRate > 0
    }

    private func installTap() {
        guard hasMicrophone, let mic else { return }
        // format: nil taps the input node at its native (voice-processed) output
        // format; the processor reads each buffer's own format and channel 0.
        engine.inputNode.installTap(onBus: 0, bufferSize: 2048, format: nil) { buffer, _ in
            mic.ingest(buffer)
        }
    }

    /// Restart with the same graph. Device switches come in bursts, so a few restarts in a row are
    /// fine; past that, or when the engine will not start again, the microphone is dropped and the
    /// call goes on without it (an engine already without one has nothing left to drop: that fails).
    private func engineConfigurationChanged() {
        guard !stopped, !reconnecting, !engine.isRunning else { return }
        let now = ProcessInfo.processInfo.systemUptime
        restartTimes = restartTimes.filter { now - $0 < Self.restartWindowSec } + [now]
        guard restartTimes.count <= Self.restartsPerWindow else {
            if hasMicrophone { microphoneLost("repeated configuration changes") } else { fail("playback-failed") }
            return
        }
        mic?.markInterruption()
        mic?.injectCancelAll() // The monitor's queued buffers do not survive either.
        playback?.cancelActive() // The queued buffers do not survive a reconfiguration.
        if hasMicrophone { engine.inputNode.removeTap(onBus: 0) }
        playback?.reconnect()
        injectMonitor?.reconnect()
        connectMixerToOutput()
        // The input device went away with this change: carry on without it rather than tap a 0-channel input.
        if hasMicrophone, !inputUsable() { microphoneLost("input device gone"); return }
        installTap()
        engine.prepare()
        do { try engine.start() } catch {
            diagnose("engine restart", error)
            if hasMicrophone { microphoneLost("restart") } else { fail("playback-failed") }
        }
    }

    private func fail(_ code: String) {
        guard !stopped else { return }
        writer.send(["type": "error", "code": code])
        finish.yield("failed")
    }

    func stop() async {
        guard !stopped else { return }
        stopped = true
        parentTimer?.cancel(); parentTimer = nil
        if let configObserver { NotificationCenter.default.removeObserver(configObserver) }
        configObserver = nil
        playback?.shutdown()
        injectMonitor?.shutdown()
        if hasMicrophone { engine.inputNode.removeTap(onBus: 0) }
        engine.stop()
        await silentMic?.stop(); silentMic = nil // Its last silence reaches the mic processor first.
        await mic?.stop(); mic = nil
        resultsTask?.cancel(); resultsTask = nil
        await analyzer?.cancelAndFinishNow(); analyzer = nil
        if let durationMs = wav.finalize() {
            writer.send(["type": "recording", "state": "closed", "durationMs": durationMs])
        } else {
            writer.send(["type": "error", "code": "recording-failed"])
        }
    }
}

@main enum PracticeAudioHelper {
    static func main() async {
        let writer = ProtocolWriter()
        let arguments = Array(CommandLine.arguments.dropFirst())
        guard arguments.count == 6, arguments[0] == "--parent-pid", arguments[2] == "--locale",
              arguments[4] == "--recording",
              let pid = Int32(arguments[1]), pid > 1, pid == getppid(), arguments[3] == "en-US" else {
            writer.send(["type": "error", "code": "capture-failed"]); return
        }
        guard WavWriter.validate(path: arguments[5]) else {
            writer.send(["type": "error", "code": "recording-failed"]); return
        }
        guard #available(macOS 26.0, *) else {
            writer.send(["type": "error", "code": "unsupported-platform"]); return
        }
        let wav: WavWriter
        do { wav = try WavWriter(path: arguments[5]) }
        catch { writer.send(["type": "error", "code": "recording-failed"]); return }
        signal(SIGPIPE, SIG_IGN)
        signal(SIGTERM, SIG_IGN)
        signal(SIGINT, SIG_IGN)
        let (terminations, finish) = AsyncStream<String>.makeStream(bufferingPolicy: .bufferingNewest(1))
        let term = DispatchSource.makeSignalSource(signal: SIGTERM, queue: .global())
        let interrupt = DispatchSource.makeSignalSource(signal: SIGINT, queue: .global())
        term.setEventHandler { finish.yield("stopped") }; term.resume()
        interrupt.setEventHandler { finish.yield("stopped") }; interrupt.resume()
        // Commands are bounded by a semaphore: the reader stalls (pipe
        // back-pressure) instead of buffering without limit.
        let (commands, commandInput) = AsyncStream<Command>.makeStream(bufferingPolicy: .unbounded)
        let slots = DispatchSemaphore(value: 256)
        // EOF also handles owner crashes without depending on PID reuse.
        DispatchQueue.global(qos: .utility).async {
            StdinReader.run { line in
                guard let command = Command.parse(line) else { return true }
                if case .stop = command { return false }
                slots.wait()
                commandInput.yield(command)
                return true
            }
            finish.yield("stopped")
        }
        let session = PracticeSession(parentPID: pid, locale: Locale(identifier: "en-US"),
                                      writer: writer, wav: wav, finish: finish)
        let dispatcher = Task {
            for await command in commands { session.handle(command); slots.signal() }
        }
        let startup = Task { await session.start() }
        for await _ in terminations { break }
        startup.cancel(); dispatcher.cancel()
        await session.stop()
        commandInput.finish(); finish.finish(); term.cancel(); interrupt.cancel()
    }
}

import Foundation
import OnnxRuntimeBindings

/// Supertonic 3 on the phone: the chosen voice (Lily by default), speed 1.2, with few steps for speed.
/// All work runs on one queue: ONNX sessions must not run while being unloaded.
final class SupertonicEngine: @unchecked Sendable {
    static let shared = SupertonicEngine()

    private static let steps = 8
    private static let speed: Float = 1.2
    private static let pauseBetweenPhrases: Float = 0.25
    /// Short phrases give a fast first sound. This is a limit, not an exact length.
    private static let maxPhraseLength = 140

    private let queue = DispatchQueue(label: "cc.grosst.herb.supertonic", qos: .userInitiated)
    private var loaded: (env: ORTEnv, tts: TextToSpeech, style: Style, voice: String)?

    /// Cancellation flag, checked between phrases.
    final class Job: @unchecked Sendable {
        private let lock = NSLock()
        private var cancelled = false

        var isCancelled: Bool {
            lock.lock()
            defer { lock.unlock() }
            return cancelled
        }

        func cancel() {
            lock.lock()
            cancelled = true
            lock.unlock()
        }
    }

    static func phrases(of text: String) -> [String] {
        // NFC keeps composed letters whole during splitting. Synthesis decomposes the text itself.
        chunkText(text.precomposedStringWithCanonicalMapping, maxLen: maxPhraseLength).filter { !$0.isEmpty }
    }

    private func engine() throws -> (env: ORTEnv, tts: TextToSpeech, style: Style) {
        let voice = SpeechVoice.selected.id
        // Downloaded in Settings. Without it the iOS voice speaks.
        guard VoiceModel.isInstalled else { throw APIError.message("The voice is not downloaded") }
        let root = VoiceModel.directory.path
        if let loaded {
            if loaded.voice == voice { return (loaded.env, loaded.tts, loaded.style) }
            // Another voice was chosen: only the small style file changes.
            let style = try loadVoiceStyle(["\(root)/\(voice).json"], verbose: false)
            self.loaded = (loaded.env, loaded.tts, style, voice)
            return (loaded.env, loaded.tts, style)
        }
        let env = try ORTEnv(loggingLevel: .warning)
        let tts = try loadTextToSpeech(root, false, env)
        let style = try loadVoiceStyle(["\(root)/\(voice).json"], verbose: false)
        loaded = (env, tts, style, voice)
        return (env, tts, style)
    }

    /// Generates phrases in order. onPhrase fires after each one, so sound plays while the rest is computed.
    func generate(
        phrases: [String],
        language: String,
        job: Job,
        onPhrase: @escaping @Sendable (_ index: Int, _ samples: [Float], _ sampleRate: Int) -> Void,
        onFailure: @escaping @Sendable (_ index: Int) -> Void,
        onDone: @escaping @Sendable () -> Void
    ) {
        queue.async { [self] in
            for (index, phrase) in phrases.enumerated() {
                if job.isCancelled { return }
                do {
                    let engine = try engine()
                    let result = try engine.tts.batch([phrase], [language], engine.style, Self.steps, speed: Self.speed)
                    guard let duration = result.duration.first, duration > 0 else {
                        throw APIError.message("The voice model returned no audio")
                    }
                    let count = min(Int(duration * Float(engine.tts.sampleRate)), result.wav.count)
                    var samples = [Float]()
                    let pause = index > 0 ? Int(Self.pauseBetweenPhrases * Float(engine.tts.sampleRate)) : 0
                    samples.reserveCapacity(pause + count)
                    samples.append(contentsOf: repeatElement(0, count: pause))
                    samples.append(contentsOf: result.wav.prefix(count))
                    if job.isCancelled { return }
                    onPhrase(index, samples, engine.tts.sampleRate)
                } catch {
                    onFailure(index)
                    return
                }
            }
            onDone()
        }
    }

    /// The model takes hundreds of megabytes, so it is not kept in memory between calls.
    func unload() {
        queue.async { [self] in loaded = nil }
    }
}

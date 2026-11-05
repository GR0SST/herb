import Foundation
import OnnxRuntimeBindings

/// Supertonic 3 на телефоне с настройками голоса из Ringmind: Lily (F2), скорость 1,2. Шагов меньше ради скорости.
/// Вся работа идёт на одной очереди: ONNX-сессии нельзя запускать параллельно с выгрузкой.
final class SupertonicEngine: @unchecked Sendable {
    static let shared = SupertonicEngine()

    private static let steps = 8
    private static let speed: Float = 1.2
    private static let voice = "F2"
    private static let pauseBetweenPhrases: Float = 0.25
    /// Короткие фразы дают быстрый первый звук. Предел длины, а не точная длина.
    private static let maxPhraseLength = 140

    private let queue = DispatchQueue(label: "cc.grosst.herb.supertonic", qos: .userInitiated)
    private var loaded: (env: ORTEnv, tts: TextToSpeech, style: Style)?

    /// Флаг отмены, который проверяется между фразами.
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
        // NFC сохраняет й и ё целыми до разбиения, а синтез сам разложит текст на символы.
        chunkText(text.precomposedStringWithCanonicalMapping, maxLen: maxPhraseLength).filter { !$0.isEmpty }
    }

    private func engine() throws -> (env: ORTEnv, tts: TextToSpeech, style: Style) {
        if let loaded { return loaded }
        guard let root = Bundle.main.resourcePath else { throw APIError.message("Voice model files are missing") }
        let env = try ORTEnv(loggingLevel: .warning)
        let tts = try loadTextToSpeech(root, false, env)
        let style = try loadVoiceStyle(["\(root)/\(Self.voice).json"], verbose: false)
        let value = (env, tts, style)
        loaded = value
        return value
    }

    /// Генерирует фразы по очереди. onPhrase вызывается сразу после каждой: так звук идёт, пока остальное считается.
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

    /// Модель занимает сотни мегабайт, поэтому между звонками её в памяти нет.
    func unload() {
        queue.async { [self] in loaded = nil }
    }
}

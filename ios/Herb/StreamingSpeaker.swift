import AVFoundation
import NaturalLanguage

/// Играет речь по мере генерации. Подготовка начинается во время звонка, а звук включается после ответа.
@MainActor
final class StreamingSpeaker {
    enum End {
        case finished
        /// Модель не справилась: этот текст нужно дочитать другим голосом.
        case fallback(String)
    }

    private static let firstAudioTimeout: Duration = .seconds(10)

    private let engine = AVAudioEngine()
    private let node = AVAudioPlayerNode()
    private var attached = false
    private var observer: NSObjectProtocol?

    private var id: UUID?
    private var job: SupertonicEngine.Job?
    private var phrases: [String] = []
    private var ready: [AVAudioPCMBuffer] = []
    private var failedAt: Int?
    private var generationEnded = false
    private var playing = false
    private var scheduledAny = false
    private var inFlight = 0
    private var onEnd: ((End) -> Void)?
    private var onFirstAudio: (() -> Void)?

    func prepare(id: UUID, text: String, language: String?) {
        guard self.id != id else { return }
        cancel()
        self.id = id
        let phrases = SupertonicEngine.phrases(of: text)
        self.phrases = phrases
        let job = SupertonicEngine.Job()
        self.job = job
        SupertonicEngine.shared.generate(
            phrases: phrases,
            language: Self.resolveLanguage(language, text: text),
            job: job,
            onPhrase: { [weak self] _, samples, sampleRate in
                Task { @MainActor in self?.received(id, samples, sampleRate) }
            },
            onFailure: { [weak self] index in
                Task { @MainActor in self?.generationFinished(id, failedAt: index) }
            },
            onDone: { [weak self] in
                Task { @MainActor in self?.generationFinished(id, failedAt: nil) }
            }
        )
    }

    func start(id: UUID, onFirstAudio: @escaping () -> Void, onEnd: @escaping (End) -> Void) {
        guard self.id == id else {
            onEnd(.fallback(""))
            return
        }
        self.onEnd = onEnd
        self.onFirstAudio = onFirstAudio
        playing = true
        scheduleReady()
        checkFinished()
        // Будильник не должен молчать, если телефон не успевает.
        Task { [weak self] in
            try? await Task.sleep(for: Self.firstAudioTimeout)
            guard let self, self.id == id, self.playing, !self.scheduledAny else { return }
            self.end(.fallback(self.phrases.joined(separator: " ")))
        }
    }

    func cancel() {
        job?.cancel()
        job = nil
        id = nil
        phrases = []
        ready = []
        failedAt = nil
        generationEnded = false
        playing = false
        scheduledAny = false
        inFlight = 0
        onEnd = nil
        onFirstAudio = nil
        if attached {
            node.stop()
            engine.stop()
        }
        SupertonicEngine.shared.unload()
    }

    private func received(_ owner: UUID, _ samples: [Float], _ sampleRate: Int) {
        guard owner == id, let buffer = Self.buffer(samples, sampleRate) else { return }
        ready.append(buffer)
        if playing { scheduleReady() }
    }

    private func generationFinished(_ owner: UUID, failedAt index: Int?) {
        guard owner == id else { return }
        failedAt = index
        generationEnded = true
        checkFinished()
    }

    private func scheduleReady() {
        guard !ready.isEmpty else { return }
        do {
            try startEngine(format: ready[0].format)
        } catch {
            end(.fallback(phrases.joined(separator: " ")))
            return
        }
        let owner = id
        for buffer in ready {
            inFlight += 1
            node.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
                Task { @MainActor in
                    guard let self, self.id == owner else { return }
                    self.inFlight -= 1
                    self.checkFinished()
                }
            }
        }
        ready = []
        if !scheduledAny {
            scheduledAny = true
            onFirstAudio?()
        }
        if !node.isPlaying { node.play() }
    }

    private func checkFinished() {
        guard playing, generationEnded, ready.isEmpty, inFlight == 0 else { return }
        if let failedAt {
            end(.fallback(phrases[failedAt...].joined(separator: " ")))
        } else {
            end(.finished)
        }
    }

    private func end(_ result: End) {
        let callback = onEnd
        cancel()
        callback?(result)
    }

    private func startEngine(format: AVAudioFormat) throws {
        if !attached {
            engine.attach(node)
            attached = true
            // Смена выхода звука останавливает движок.
            observer = NotificationCenter.default.addObserver(
                forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated {
                    guard let self, self.playing, self.scheduledAny else { return }
                    try? self.engine.start()
                    self.node.play()
                }
            }
        }
        // Переподключение на ходу дало бы щелчок, поэтому только при запуске.
        guard !engine.isRunning else { return }
        engine.connect(node, to: engine.mainMixerNode, format: format)
        try engine.start()
    }

    /// Язык от агента или определённый по тексту. Текст без явного языка модель читает хуже.
    private static func resolveLanguage(_ language: String?, text: String) -> String {
        if let language, isValidLang(language), language != "na" { return language }
        let recognizer = NLLanguageRecognizer()
        recognizer.processString(text)
        if let detected = recognizer.dominantLanguage?.rawValue, isValidLang(detected) { return detected }
        return "na"
    }

    private static func buffer(_ samples: [Float], _ sampleRate: Int) -> AVAudioPCMBuffer? {
        guard let format = AVAudioFormat(standardFormatWithSampleRate: Double(sampleRate), channels: 1),
              let buffer = AVAudioPCMBuffer(pcmFormat: format, frameCapacity: AVAudioFrameCount(samples.count)),
              let channel = buffer.floatChannelData?[0]
        else { return nil }
        samples.withUnsafeBufferPointer { channel.update(from: $0.baseAddress!, count: samples.count) }
        buffer.frameLength = AVAudioFrameCount(samples.count)
        return buffer
    }
}

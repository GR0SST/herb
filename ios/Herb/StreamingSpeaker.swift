import AVFoundation
import NaturalLanguage

/// Plays speech as it is generated. Preparation starts while ringing and sound starts on answer.
@MainActor
final class StreamingSpeaker {
    enum End {
        case finished
        /// The model failed: this text needs another voice.
        case fallback(String)
    }

    /// A queued buffer and its place on the player's timeline.
    private struct Scheduled {
        let buffer: AVAudioPCMBuffer
        let phrase: Int
        var start: AVAudioFramePosition
        var end: AVAudioFramePosition { start + AVAudioFramePosition(buffer.frameLength) }
    }

    private static let firstAudioTimeout: Duration = .seconds(10)
    private static let positionInterval: Duration = .milliseconds(100)

    private let engine = AVAudioEngine()
    private let node = AVAudioPlayerNode()
    private var attached = false
    private var observer: NSObjectProtocol?

    private var id: UUID?
    private var job: SupertonicEngine.Job?
    private var phrases: [String] = []
    private var ready: [(buffer: AVAudioPCMBuffer, phrase: Int)] = []
    private var queue: [Scheduled] = []
    private var failedAt: Int?
    private var generationEnded = false
    private var playing = false
    private var scheduledAny = false
    /// Player position from the last poll. It cannot be read after the engine stops.
    private var position: AVAudioFramePosition = 0
    /// Changes on restart, so callbacks from flushed buffers do not count as finished.
    private var epoch = 0
    private var positionTask: Task<Void, Never>?
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
            onPhrase: { [weak self] index, samples, sampleRate in
                Task { @MainActor in self?.received(id, index, samples, sampleRate) }
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
        // An urgent call must not stay silent if the phone falls behind.
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
        queue = []
        failedAt = nil
        generationEnded = false
        playing = false
        scheduledAny = false
        position = 0
        epoch += 1
        positionTask?.cancel()
        positionTask = nil
        onEnd = nil
        onFirstAudio = nil
        if attached {
            node.stop()
            engine.stop()
        }
        SupertonicEngine.shared.unload()
    }

    private func received(_ owner: UUID, _ phrase: Int, _ samples: [Float], _ sampleRate: Int) {
        guard owner == id, let buffer = Self.buffer(samples, sampleRate) else { return }
        ready.append((buffer, phrase))
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
            try startEngine(format: ready[0].buffer.format)
        } catch {
            end(.fallback(remainingText()))
            return
        }
        for item in ready {
            // If generation fell behind, the player has moved on, so the buffer starts at the current position.
            enqueue(item.buffer, phrase: item.phrase, start: max(queue.last?.end ?? 0, currentPosition()))
        }
        ready = []
        if !scheduledAny {
            scheduledAny = true
            onFirstAudio?()
        }
        if !node.isPlaying { node.play() }
        trackPosition()
    }

    private func enqueue(_ buffer: AVAudioPCMBuffer, phrase: Int, start: AVAudioFramePosition) {
        queue.append(Scheduled(buffer: buffer, phrase: phrase, start: start))
        let scheduledEpoch = epoch
        node.scheduleBuffer(buffer, completionCallbackType: .dataPlayedBack) { [weak self] _ in
            Task { @MainActor in self?.bufferCompleted(scheduledEpoch) }
        }
    }

    /// iOS also fires this callback when the queue is flushed, so only a running engine counts as finished.
    private func bufferCompleted(_ scheduledEpoch: Int) {
        guard scheduledEpoch == epoch, engine.isRunning, !queue.isEmpty else { return }
        queue.removeFirst()
        checkFinished()
    }

    private func checkFinished() {
        guard playing, generationEnded, ready.isEmpty, queue.isEmpty else { return }
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

    /// Text not yet heard: from the current phrase to the end.
    private func remainingText() -> String {
        let first = queue.first?.phrase ?? ready.first?.phrase ?? 0
        return phrases.indices.contains(first) ? phrases[first...].joined(separator: " ") : ""
    }

    private func currentPosition() -> AVAudioFramePosition {
        guard engine.isRunning, node.isPlaying, let time = node.lastRenderTime,
              let playerTime = node.playerTime(forNodeTime: time)
        else { return position }
        position = playerTime.sampleTime
        return position
    }

    private func trackPosition() {
        guard positionTask == nil else { return }
        positionTask = Task { [weak self] in
            while !Task.isCancelled {
                _ = self?.currentPosition()
                try? await Task.sleep(for: Self.positionInterval)
            }
        }
    }

    /// A route change, such as the speaker button, stops the engine and flushes the queue.
    /// Resume where it stopped. At most one polling interval is repeated.
    private func resumeAfterRouteChange() {
        guard playing, scheduledAny, let format = queue.first?.buffer.format ?? ready.first?.buffer.format else { return }
        let heard = position
        let pendingItems = queue
        epoch += 1
        queue = []
        node.stop()
        engine.stop()
        position = 0
        engine.connect(node, to: engine.mainMixerNode, format: format)
        do {
            try engine.start()
        } catch {
            queue = pendingItems
            end(.fallback(remainingText()))
            return
        }
        var next: AVAudioFramePosition = 0
        for item in pendingItems where item.end > heard {
            let skip = max(0, heard - item.start)
            guard let buffer = skip > 0 ? Self.tail(of: item.buffer, from: skip) : item.buffer else { continue }
            enqueue(buffer, phrase: item.phrase, start: next)
            next += AVAudioFramePosition(buffer.frameLength)
        }
        if !queue.isEmpty || !ready.isEmpty {
            node.play()
            scheduleReady()
        }
        checkFinished()
    }

    private func startEngine(format: AVAudioFormat) throws {
        if !attached {
            engine.attach(node)
            attached = true
            observer = NotificationCenter.default.addObserver(
                forName: .AVAudioEngineConfigurationChange, object: engine, queue: .main
            ) { [weak self] _ in
                MainActor.assumeIsolated { self?.resumeAfterRouteChange() }
            }
        }
        // Reconnecting while running would click, so do it only on start.
        guard !engine.isRunning else { return }
        engine.connect(node, to: engine.mainMixerNode, format: format)
        try engine.start()
    }

    /// The agent's language or one detected from the text. The model reads worse without an explicit language.
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

    /// The rest of a buffer from the given frame.
    private static func tail(of source: AVAudioPCMBuffer, from offset: AVAudioFramePosition) -> AVAudioPCMBuffer? {
        let remaining = AVAudioFramePosition(source.frameLength) - offset
        guard remaining > 0, let input = source.floatChannelData?[0],
              let result = AVAudioPCMBuffer(pcmFormat: source.format, frameCapacity: AVAudioFrameCount(remaining)),
              let output = result.floatChannelData?[0]
        else { return nil }
        output.update(from: input + Int(offset), count: Int(remaining))
        result.frameLength = AVAudioFrameCount(remaining)
        return result
    }
}

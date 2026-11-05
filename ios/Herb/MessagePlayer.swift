import AVFoundation
import NaturalLanguage

/// Plays a call's message: uploaded audio, the Lily voice or the iOS fallback voice.
@MainActor
final class MessagePlayer: NSObject, @preconcurrency AVSpeechSynthesizerDelegate, @preconcurrency AVAudioPlayerDelegate {
    private let synthesizer = AVSpeechSynthesizer()
    private let speaker = StreamingSpeaker()
    private var player: AVAudioPlayer?
    private var onFinish: ((Bool) -> Void)?

    override init() {
        super.init()
        synthesizer.delegate = self
    }

    func prepareSpeech(id: UUID, text: String, language: String?) {
        speaker.prepare(id: id, text: text, language: language)
    }

    /// onFinish receives success and whether the fallback voice was used.
    func speak(id: UUID, text: String, language: String?, onFirstAudio: @escaping () -> Void, onFinish: @escaping (Bool, Bool) -> Void) {
        speaker.start(id: id, onFirstAudio: onFirstAudio) { [weak self] end in
            guard let self else { return }
            switch end {
            case .finished:
                onFinish(true, false)
            case .fallback(let remaining):
                let rest = remaining.isEmpty ? text : remaining
                onFirstAudio()
                self.onFinish = { onFinish($0, true) }
                self.speakWithSystemVoice(rest.withoutStressMarks)
            }
        }
    }

    func play(_ data: Data, onFinish: @escaping (Bool) -> Void) throws {
        stop()
        let player = try AVAudioPlayer(data: data)
        player.delegate = self
        self.player = player
        self.onFinish = onFinish
        guard player.play() else {
            self.player = nil
            self.onFinish = nil
            throw APIError.message("Could not play the audio")
        }
    }

    /// Stops without calling onFinish: whoever interrupts handles that.
    func stop() {
        onFinish = nil
        speaker.cancel()
        if synthesizer.isSpeaking { synthesizer.stopSpeaking(at: .immediate) }
        player?.stop()
        player = nil
    }

    private func speakWithSystemVoice(_ text: String) {
        let utterance = AVSpeechUtterance(string: text)
        utterance.voice = Self.voice(for: text)
        synthesizer.speak(utterance)
    }

    private func finish(_ success: Bool) {
        let callback = onFinish
        onFinish = nil
        callback?(success)
    }

    private static func voice(for text: String) -> AVSpeechSynthesisVoice? {
        let recognizer = NLLanguageRecognizer()
        recognizer.processString(text)
        guard let language = recognizer.dominantLanguage?.rawValue else { return nil }
        return AVSpeechSynthesisVoice.speechVoices()
            .filter { $0.language.hasPrefix(language) }
            .max { $0.quality.rawValue < $1.quality.rawValue }
    }

    func speechSynthesizer(_ synthesizer: AVSpeechSynthesizer, didFinish utterance: AVSpeechUtterance) {
        finish(true)
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        finish(flag)
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        finish(false)
    }
}

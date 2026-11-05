import AVFoundation
import CallKit
import Observation
import PushKit

struct CallSession: Identifiable, Equatable {
    enum Phase: Equatable {
        case ringing, connecting, playing
        case ended(String)
    }

    let id: UUID
    let botName: String
    let title: String?
    let startedAt = Date()
    var text: String?
    var phase: Phase = .ringing
}

/// Calls: VoIP push, CallKit and message playback.
/// CallKit shows no call in the simulator, so the app's own screen is used there.
@MainActor
@Observable
final class CallCenter: NSObject {
    private(set) var sessions: [UUID: CallSession] = [:]
    private(set) var voipToken: String?

    @ObservationIgnored var api: () -> API? = { nil }
    @ObservationIgnored var onVoipToken: (String) -> Void = { _ in }
    @ObservationIgnored var onCallFinished: () -> Void = {}

    @ObservationIgnored private let provider: CXProvider
    @ObservationIgnored private let controller = CXCallController()
    @ObservationIgnored private let registry = PKPushRegistry(queue: .main)
    @ObservationIgnored private let player = MessagePlayer()
    @ObservationIgnored private var known: Set<UUID> = []
    @ObservationIgnored private var audioActive = false
    @ObservationIgnored private var pending: (id: UUID, message: Message)?

    private enum Message {
        case text(String, language: String?)
        case audio(Data)
    }

    private static let ringTimeout: Duration = .seconds(60)

    #if targetEnvironment(simulator)
    private let useCallKit = false
    #else
    private let useCallKit = true
    #endif

    var active: CallSession? {
        sessions.values.max { $0.startedAt < $1.startedAt }
    }

    override init() {
        let configuration = CXProviderConfiguration()
        configuration.supportsVideo = false
        configuration.maximumCallGroups = 1
        configuration.maximumCallsPerCallGroup = 1
        configuration.supportedHandleTypes = [.generic]
        configuration.includesCallsInRecents = false
        provider = CXProvider(configuration: configuration)
        super.init()
        provider.setDelegate(self, queue: .main)
    }

    func start() {
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
    }

    /// A call found by polling while the app is open.
    func reportIfNew(_ record: CallRecord) {
        guard let id = UUID(uuidString: record.id), !known.contains(id) else { return }
        report(id: id, botName: record.botName, title: record.title) {}
    }

    private func report(id: UUID, botName: String, title: String?, completion: @escaping () -> Void) {
        known.insert(id)
        if sessions[id] == nil {
            sessions[id] = CallSession(id: id, botName: botName, title: title)
        }
        guard useCallKit else {
            scheduleTimeout(id)
            prepareMessage(id)
            completion()
            return
        }
        let update = CXCallUpdate()
        update.remoteHandle = CXHandle(type: .generic, value: botName)
        update.localizedCallerName = botName
        update.hasVideo = false
        update.supportsDTMF = false
        update.supportsHolding = false
        update.supportsGrouping = false
        update.supportsUngrouping = false
        provider.reportNewIncomingCall(with: id, update: update) { [weak self] error in
            MainActor.assumeIsolated {
                if let error = error as? CXErrorCodeIncomingCallError, error.code == .callUUIDAlreadyExists {
                    // Polling and push reported the same call, which is fine.
                } else if error != nil {
                    // For example Do Not Disturb. The call was not shown.
                    self?.finish(id, relayStatus: .missed)
                } else {
                    self?.scheduleTimeout(id)
                    self?.prepareMessage(id)
                }
                completion()
            }
        }
    }

    /// Starts speech while the phone rings, so the first phrase is ready on answer.
    private func prepareMessage(_ id: UUID) {
        guard let api = api() else { return }
        Task { [weak self] in
            guard let record = try? await api.call(id: id), let self, self.sessions[id]?.phase == .ringing,
                  !record.hasAudio, let text = record.text
            else { return }
            self.player.prepareSpeech(id: id, text: text, language: record.language)
        }
    }

    private func scheduleTimeout(_ id: UUID) {
        Task { [weak self] in
            try? await Task.sleep(for: Self.ringTimeout)
            guard let self, self.sessions[id]?.phase == .ringing else { return }
            if self.useCallKit { self.provider.reportCall(with: id, endedAt: nil, reason: .unanswered) }
            self.finish(id, relayStatus: .missed)
        }
    }

    // MARK: In-app call buttons

    func answer(_ id: UUID) {
        if useCallKit {
            controller.request(CXTransaction(action: CXAnswerCallAction(call: id))) { _ in }
        } else {
            beginAnswer(id)
            sessionDidActivate()
        }
    }

    func end(_ id: UUID) {
        if useCallKit {
            controller.request(CXTransaction(action: CXEndCallAction(call: id))) { _ in }
        } else {
            handleEnd(id)
        }
    }

    // MARK: Call flow

    private func beginAnswer(_ id: UUID) {
        guard sessions[id] != nil else { return }
        sessions[id]?.phase = .connecting
        do {
            // Call mode: audio plays through the earpiece and the speaker toggle works as usual.
            // Nothing is recorded, but iOS offers the earpiece only in this mode.
            try AVAudioSession.sharedInstance().setCategory(.playAndRecord, mode: .voiceChat, options: [.allowBluetoothHFP])
        } catch {
            finishAfterFailure(id, "Could not set up audio")
            return
        }
        Task { await loadMessage(id) }
    }

    private func loadMessage(_ id: UUID) async {
        guard let api = api() else {
            finishAfterFailure(id, "No connection to the server")
            return
        }
        do {
            try await api.setStatus(callID: id, .answered)
            let record = try await api.call(id: id)
            sessions[id]?.text = record.text
            if record.hasAudio {
                pending = (id, .audio(try await api.audio(callID: id)))
            } else if let text = record.text {
                player.prepareSpeech(id: id, text: text, language: record.language)
                pending = (id, .text(text, language: record.language))
            } else {
                // A call without a message: answering is enough.
                finish(id, relayStatus: nil, note: "Answered")
                endSystemCall(id)
                return
            }
            playIfReady()
        } catch {
            finishAfterFailure(id, error.localizedDescription)
        }
    }

    private func sessionDidActivate() {
        audioActive = true
        if !useCallKit {
            try? AVAudioSession.sharedInstance().setActive(true)
        }
        playIfReady()
    }

    /// Playback needs both the message and an active audio session.
    private func playIfReady() {
        guard audioActive, let (id, message) = pending, sessions[id] != nil else { return }
        pending = nil
        sessions[id]?.phase = .playing
        let done: (Bool, Bool) -> Void = { [weak self] success, _ in
            guard let self else { return }
            if success {
                self.finish(id, relayStatus: .played)
            } else {
                self.finish(id, relayStatus: .failed, note: "Could not play the message")
            }
            self.endSystemCall(id)
        }
        switch message {
        case .text(let text, let language):
            player.speak(id: id, text: text, language: language, onFirstAudio: {}, onFinish: done)
        case .audio(let data):
            do {
                try player.play(data, onFinish: { done($0, false) })
            } catch {
                finishAfterFailure(id, error.localizedDescription)
            }
        }
    }

    private func handleEnd(_ id: UUID) {
        guard let session = sessions[id] else { return }
        switch session.phase {
        case .ringing:
            finish(id, relayStatus: .declined)
        case .connecting, .playing:
            // Answered but not heard to the end, so the status stays answered.
            finish(id, relayStatus: nil, note: "Ended")
        case .ended:
            break
        }
    }

    private func finishAfterFailure(_ id: UUID, _ note: String) {
        finish(id, relayStatus: .failed, note: note)
        endSystemCall(id)
    }

    private func endSystemCall(_ id: UUID) {
        guard useCallKit else { return }
        provider.reportCall(with: id, endedAt: nil, reason: .remoteEnded)
    }

    private func finish(_ id: UUID, relayStatus: CallStatus?, note: String? = nil) {
        guard let session = sessions[id] else { return }
        if case .ended = session.phase { return }
        if pending?.id == id { pending = nil }
        player.stop()
        sessions[id]?.phase = .ended(note ?? relayStatus?.label ?? "Ended")
        if !useCallKit { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
        Task { [weak self] in
            if let relayStatus, let api = self?.api() {
                try? await api.setStatus(callID: id, relayStatus)
            }
            self?.onCallFinished()
        }
        // The result shows for two seconds, then the call screen closes.
        Task { [weak self] in
            try? await Task.sleep(for: .seconds(2))
            self?.sessions[id] = nil
        }
    }
}

extension CallCenter: PKPushRegistryDelegate {
    nonisolated func pushRegistry(_ registry: PKPushRegistry, didUpdate credentials: PKPushCredentials, for type: PKPushType) {
        let token = credentials.token.map { String(format: "%02x", $0) }.joined()
        MainActor.assumeIsolated {
            voipToken = token
            onVoipToken(token)
        }
    }

    nonisolated func pushRegistry(
        _ registry: PKPushRegistry,
        didReceiveIncomingPushWith payload: PKPushPayload,
        for type: PKPushType,
        completion: @escaping () -> Void
    ) {
        let data = payload.dictionaryPayload
        let id = (data["call_id"] as? String).flatMap(UUID.init(uuidString:))
        let botName = data["bot_name"] as? String ?? "Herb"
        let title = data["title"] as? String
        MainActor.assumeIsolated {
            // iOS requires a reported call for every VoIP push, or it terminates the app.
            guard let id else {
                let fallback = UUID()
                report(id: fallback, botName: botName, title: nil) { [weak self] in
                    self?.provider.reportCall(with: fallback, endedAt: nil, reason: .failed)
                    self?.finish(fallback, relayStatus: nil, note: "Invalid call")
                    completion()
                }
                return
            }
            report(id: id, botName: botName, title: title, completion: completion)
        }
    }
}

extension CallCenter: CXProviderDelegate {
    nonisolated func providerDidReset(_ provider: CXProvider) {
        MainActor.assumeIsolated {
            player.stop()
            pending = nil
            audioActive = false
            for id in sessions.keys { finish(id, relayStatus: nil) }
        }
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXAnswerCallAction) {
        let id = action.callUUID
        MainActor.assumeIsolated { beginAnswer(id) }
        action.fulfill()
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        let id = action.callUUID
        MainActor.assumeIsolated { handleEnd(id) }
        action.fulfill()
    }

    nonisolated func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        MainActor.assumeIsolated { sessionDidActivate() }
    }

    nonisolated func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        MainActor.assumeIsolated { audioActive = false }
    }
}

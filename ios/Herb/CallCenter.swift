import AVFoundation
import CallKit
import Observation
import PushKit

struct CallSession: Identifiable, Equatable {
    enum Phase: Equatable {
        case ringing, connecting, playing
        /// A two-way conversation is going on.
        case live
        /// The message is over, but the line stays open until the person hangs up.
        case waiting(String)
        case ended(String)
    }

    let id: UUID
    let botName: String
    let title: String?
    let startedAt = Date()
    var text: String?
    var phase: Phase = .ringing
    var live = false
    /// The phone called the agent, not the other way round.
    var outgoing = false
    var botID: String?
    /// The server's call id when it differs from the CallKit id, as for calls the phone starts.
    var serverID: String?
    var lines: [Line] = []
    var muted = false

    var relayID: String { serverID ?? id.uuidString.lowercased() }

    struct Line: Identifiable, Equatable {
        let id = UUID()
        let speaker: LiveConnection.Speaker
        var text: String
    }
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
    @ObservationIgnored private var liveCall: (id: UUID, connection: LiveConnection)?
    @ObservationIgnored private let ringback = Ringback()

    private enum Message {
        case text(String, language: String?)
        case audio(Data)
    }

    private static let ringTimeout: Duration = .seconds(60)

    static let autoHangUpKey = "autoHangUp"

    /// When off, a call stays open after the message until the person hangs up.
    private var autoHangUp: Bool {
        UserDefaults.standard.object(forKey: Self.autoHangUpKey) as? Bool ?? true
    }

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
        LiveConnection.useCallKitAudio(useCallKit)
        registry.delegate = self
        registry.desiredPushTypes = [.voIP]
    }

    /// A call found by polling while the app is open.
    func reportIfNew(_ record: CallRecord) {
        guard let id = UUID(uuidString: record.id), !known.contains(id) else { return }
        report(id: id, botName: record.botName, title: record.title, live: record.live ?? false) {}
    }

    private func report(id: UUID, botName: String, title: String?, live: Bool = false, completion: @escaping () -> Void) {
        known.insert(id)
        if sessions[id] == nil {
            sessions[id] = CallSession(id: id, botName: botName, title: title, live: live)
        }
        guard useCallKit else {
            scheduleTimeout(id)
            prepareMessage(id)
            completion()
            #if DEBUG
            // App Store screenshots of a call in progress: -HerbDemoAnswer YES
            if UserDefaults.standard.bool(forKey: "HerbDemoAnswer") {
                Task { [weak self] in
                    try? await Task.sleep(for: .seconds(2))
                    self?.answer(id)
                }
            }
            #endif
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
        guard let api = api(), sessions[id]?.live == false else { return }
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

    /// The phone calls an agent for a two-way conversation.
    func callAgent(_ bot: Bot) {
        guard active == nil else { return }
        let id = UUID()
        known.insert(id)
        var session = CallSession(id: id, botName: bot.name, title: nil, live: true, outgoing: true, botID: bot.id)
        session.phase = .connecting
        sessions[id] = session
        guard useCallKit else {
            beginAnswer(id)
            sessionDidActivate()
            return
        }
        let action = CXStartCallAction(call: id, handle: CXHandle(type: .generic, value: bot.name))
        controller.request(CXTransaction(action: action)) { [weak self] error in
            guard error != nil else { return }
            Task { @MainActor in self?.finish(id, relayStatus: nil, note: "Could not start the call") }
        }
    }

    func setMuted(_ id: UUID, _ muted: Bool) {
        if useCallKit {
            controller.request(CXTransaction(action: CXSetMutedCallAction(call: id, muted: muted))) { _ in }
        } else {
            applyMute(id, muted)
        }
    }

    private func applyMute(_ id: UUID, _ muted: Bool) {
        sessions[id]?.muted = muted
        if liveCall?.id == id { liveCall?.connection.muted = muted }
    }

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
        if sessions[id]?.live == true {
            Task { await connectLive(id) }
        } else {
            Task { await loadMessage(id) }
        }
    }

    private func connectLive(_ id: UUID) async {
        guard let api = api(), let session = sessions[id] else {
            finishAfterFailure(id, "No connection to the server")
            return
        }
        let connection = LiveConnection()
        connection.muted = session.muted
        connection.onTranscript = { [weak self] speaker, delta in
            self?.hear(id, speaker, delta)
            // Speech means the agent is on the line, even if the start event was missed.
            self?.agentReady(id)
        }
        connection.onReady = { [weak self] in self?.agentReady(id) }
        connection.onEnded = { [weak self] note in
            self?.finish(id, relayStatus: nil, note: note)
            self?.endSystemCall(id)
        }
        liveCall = (id, connection)
        do {
            let offer = try await connection.makeOffer()
            let started = if session.outgoing, let botID = session.botID {
                try await api.startLive(botID: botID, sdp: offer)
            } else {
                try await api.joinLive(callID: session.relayID, sdp: offer)
            }
            sessions[id]?.serverID = started.call.id
            guard sessions[id]?.phase == .connecting else {
                // Hung up while connecting.
                connection.close()
                try? await api.endLive(callID: started.call.id)
                return
            }
            try await connection.accept(answer: started.voice.sdp)
            // Ringback plays until the voice agent is on the line. Give up waiting after a few seconds.
            Task { [weak self] in
                try? await Task.sleep(for: .seconds(8))
                self?.agentReady(id)
            }
        } catch {
            connection.close()
            finishAfterFailure(id, error.localizedDescription)
        }
    }

    private func agentReady(_ id: UUID) {
        guard sessions[id]?.phase == .connecting, liveCall?.id == id else { return }
        ringback.stop()
        sessions[id]?.phase = .live
        if useCallKit, sessions[id]?.outgoing == true { provider.reportOutgoingCall(with: id, connectedAt: nil) }
    }

    /// Transcript pieces arrive word by word: they join into lines per speaker.
    private func hear(_ id: UUID, _ speaker: LiveConnection.Speaker, _ delta: String) {
        guard var lines = sessions[id]?.lines else { return }
        if let last = lines.indices.last, lines[last].speaker == speaker {
            lines[last].text += delta
        } else {
            let text = delta.trimmingCharacters(in: .whitespaces)
            guard !text.isEmpty else { return }
            lines.append(.init(speaker: speaker, text: text))
        }
        sessions[id]?.lines = lines
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
                complete(id, relayStatus: nil, note: "Answered")
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
        if let session = active, session.live, session.phase == .connecting { ringback.start() }
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
                self.complete(id, relayStatus: .played)
            } else {
                self.finishAfterFailure(id, "Could not play the message")
            }
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
        case .connecting, .playing, .live:
            // Answered but not heard to the end, so the status stays answered.
            finish(id, relayStatus: nil, note: "Ended")
        case .waiting(let note):
            finish(id, relayStatus: nil, note: note)
        case .ended:
            break
        }
    }

    /// The message was delivered: hang up, or keep the line open if auto hang up is off.
    private func complete(_ id: UUID, relayStatus: CallStatus?, note: String? = nil) {
        guard autoHangUp else {
            guard let session = sessions[id] else { return }
            if case .ended = session.phase { return }
            player.stop()
            sessions[id]?.phase = .waiting(note ?? relayStatus?.label ?? "Ended")
            if let relayStatus, let api = api() {
                Task { try? await api.setStatus(callID: id, relayStatus) }
            }
            return
        }
        finish(id, relayStatus: relayStatus, note: note)
        endSystemCall(id)
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
        if liveCall?.id == id {
            liveCall?.connection.close()
            liveCall = nil
            ringback.stop()
        }
        // The server tracks an answered live call itself: the phone only says it hung up.
        let liveAnswered = session.live && session.phase != .ringing
        let relayID = session.serverID ?? (session.outgoing ? nil : session.relayID)
        sessions[id]?.phase = .ended(note ?? relayStatus?.label ?? "Ended")
        if !useCallKit { try? AVAudioSession.sharedInstance().setActive(false, options: .notifyOthersOnDeactivation) }
        Task { [weak self] in
            if liveAnswered {
                if let relayID, let api = self?.api() { try? await api.endLive(callID: relayID) }
            } else if let relayStatus, let api = self?.api() {
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
        let live = data["live"] as? Bool ?? false
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
            report(id: id, botName: botName, title: title, live: live, completion: completion)
        }
    }
}

extension CallCenter: CXProviderDelegate {
    nonisolated func providerDidReset(_ provider: CXProvider) {
        MainActor.assumeIsolated {
            player.stop()
            ringback.stop()
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

    nonisolated func provider(_ provider: CXProvider, perform action: CXStartCallAction) {
        let id = action.callUUID
        MainActor.assumeIsolated {
            let update = CXCallUpdate()
            update.remoteHandle = action.handle
            update.localizedCallerName = sessions[id]?.botName
            update.hasVideo = false
            provider.reportCall(with: id, updated: update)
            provider.reportOutgoingCall(with: id, startedConnectingAt: nil)
            beginAnswer(id)
        }
        action.fulfill()
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXSetMutedCallAction) {
        let id = action.callUUID
        let muted = action.isMuted
        MainActor.assumeIsolated { applyMute(id, muted) }
        action.fulfill()
    }

    nonisolated func provider(_ provider: CXProvider, perform action: CXEndCallAction) {
        let id = action.callUUID
        MainActor.assumeIsolated { handleEnd(id) }
        action.fulfill()
    }

    nonisolated func provider(_ provider: CXProvider, didActivate audioSession: AVAudioSession) {
        MainActor.assumeIsolated {
            LiveConnection.audioDidActivate(audioSession)
            sessionDidActivate()
        }
    }

    nonisolated func provider(_ provider: CXProvider, didDeactivate audioSession: AVAudioSession) {
        MainActor.assumeIsolated {
            LiveConnection.audioDidDeactivate(audioSession)
            audioActive = false
        }
    }
}

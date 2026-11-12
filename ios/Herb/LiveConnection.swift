import AVFoundation
import WebRTC

/// The phone's side of a live call: microphone and speaker over WebRTC to GPT-Live.
/// The server exchanges the offer, so no API key is on the phone. The data channel only receives
/// transcripts and session events; the server steers the conversation.
@MainActor
final class LiveConnection: NSObject {
    enum Speaker { case user, agent }

    var onTranscript: (Speaker, String) -> Void = { _, _ in }
    /// The voice agent is on the line.
    var onReady: () -> Void = {}
    /// The call ended on the other side or the connection dropped.
    var onEnded: (String) -> Void = { _ in }

    private static let factory: RTCPeerConnectionFactory = {
        RTCInitializeSSL()
        return RTCPeerConnectionFactory()
    }()

    private var peer: RTCPeerConnection?
    private var channel: RTCDataChannel?
    private var microphone: RTCAudioTrack?
    private var ended = false

    var muted = false {
        didSet { microphone?.isEnabled = !muted }
    }

    /// CallKit owns the audio session: WebRTC waits until it is active.
    static func useCallKitAudio(_ enabled: Bool) {
        let session = RTCAudioSession.sharedInstance()
        session.useManualAudio = enabled
        session.isAudioEnabled = !enabled
    }

    static func audioDidActivate(_ audioSession: AVAudioSession) {
        let session = RTCAudioSession.sharedInstance()
        session.audioSessionDidActivate(audioSession)
        session.isAudioEnabled = true
    }

    static func audioDidDeactivate(_ audioSession: AVAudioSession) {
        let session = RTCAudioSession.sharedInstance()
        session.audioSessionDidDeactivate(audioSession)
        session.isAudioEnabled = false
    }

    /// Creates the WebRTC offer for the server.
    func makeOffer() async throws -> String {
        let configuration = RTCConfiguration()
        configuration.sdpSemantics = .unifiedPlan
        let constraints = RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil)
        guard let peer = Self.factory.peerConnection(with: configuration, constraints: constraints, delegate: self) else {
            throw APIError.message("Could not start the call")
        }
        self.peer = peer

        let source = Self.factory.audioSource(with: RTCMediaConstraints(mandatoryConstraints: nil, optionalConstraints: nil))
        let track = Self.factory.audioTrack(with: source, trackId: "microphone")
        track.isEnabled = !muted
        peer.add(track, streamIds: ["herb"])
        microphone = track

        let channelConfiguration = RTCDataChannelConfiguration()
        channel = peer.dataChannel(forLabel: "oai-events", configuration: channelConfiguration)
        channel?.delegate = self

        let offerConstraints = RTCMediaConstraints(mandatoryConstraints: ["OfferToReceiveAudio": "true"], optionalConstraints: nil)
        let offer: RTCSessionDescription = try await withCheckedThrowingContinuation { continuation in
            peer.offer(for: offerConstraints) { description, error in
                if let description { continuation.resume(returning: description) } else {
                    continuation.resume(throwing: error ?? APIError.message("Could not start the call"))
                }
            }
        }
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peer.setLocalDescription(offer) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
        return offer.sdp
    }

    func accept(answer sdp: String) async throws {
        guard let peer else { throw APIError.message("The call has ended") }
        let answer = RTCSessionDescription(type: .answer, sdp: sdp)
        try await withCheckedThrowingContinuation { (continuation: CheckedContinuation<Void, Error>) in
            peer.setRemoteDescription(answer) { error in
                if let error { continuation.resume(throwing: error) } else { continuation.resume() }
            }
        }
    }

    func close() {
        ended = true
        channel?.close()
        peer?.close()
        channel = nil
        peer = nil
        microphone = nil
    }

    private func finish(_ note: String) {
        guard !ended else { return }
        close()
        onEnded(note)
    }

    private func handle(_ data: Data) {
        guard let event = try? JSONSerialization.jsonObject(with: data) as? [String: Any],
              let type = event["type"] as? String
        else { return }
        switch type {
        case "session.input_transcript.delta":
            if let delta = event["delta"] as? String { onTranscript(.user, delta) }
        case "session.output_transcript.delta":
            if let delta = event["delta"] as? String { onTranscript(.agent, delta) }
        case "session.started":
            onReady()
        case "session.closed":
            finish("Ended")
        default:
            break
        }
    }
}

extension LiveConnection: RTCPeerConnectionDelegate {
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange stateChanged: RTCSignalingState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didAdd stream: RTCMediaStream) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove stream: RTCMediaStream) {}
    nonisolated func peerConnectionShouldNegotiate(_ peerConnection: RTCPeerConnection) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceGatheringState) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didGenerate candidate: RTCIceCandidate) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didRemove candidates: [RTCIceCandidate]) {}
    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didOpen dataChannel: RTCDataChannel) {}

    nonisolated func peerConnection(_ peerConnection: RTCPeerConnection, didChange newState: RTCIceConnectionState) {
        guard newState == .failed || newState == .closed else { return }
        Task { @MainActor in self.finish("Connection lost") }
    }
}

extension LiveConnection: RTCDataChannelDelegate {
    nonisolated func dataChannelDidChangeState(_ dataChannel: RTCDataChannel) {}

    nonisolated func dataChannel(_ dataChannel: RTCDataChannel, didReceiveMessageWith buffer: RTCDataBuffer) {
        let data = buffer.data
        Task { @MainActor in self.handle(data) }
    }
}

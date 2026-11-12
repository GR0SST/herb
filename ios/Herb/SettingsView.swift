import AVFoundation
import SwiftUI
import UIKit

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmDelete = false
    @State private var confirmSignOut = false
    @State private var isWorking = false
    @State private var showKey = false
    @State private var copied = false
    @State private var error: String?
    @AppStorage(CallCenter.autoHangUpKey) private var autoHangUp = true

    var body: some View {
        NavigationStack {
            List {
                if model.pushUnavailable {
                    Label("Calls ring only while Herb is open", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.secondary)
                }
                Section {
                    LabeledContent("Server", value: model.connection?.baseURL.host() ?? "—")
                    if let key = model.accountKey {
                        Button {
                            if showKey {
                                UIPasteboard.general.string = key
                                copied = true
                            } else {
                                showKey = true
                            }
                        } label: {
                            LabeledContent("Account Key") {
                                if showKey {
                                    Text(copied ? "Copied" : key)
                                        .font(.footnote.monospaced())
                                        .multilineTextAlignment(.trailing)
                                } else {
                                    Text("Show")
                                }
                            }
                        }
                        .foregroundStyle(.primary)
                    }
                }
                if let live = model.status?.live, live.available, live.billing {
                    Section {
                        LabeledContent("Live Minutes Left", value: "\((live.secondsLeft ?? 0) / 60)")
                    }
                }
                VoiceSection()
                Section {
                    Toggle("Auto Hang Up", isOn: $autoHangUp)
                } footer: {
                    Text("When off, a call stays open after the message until you hang up.")
                }
                Section {
                    Button("Sign Out") { confirmSignOut = true }
                        .disabled(isWorking)
                    Button("Delete Account", role: .destructive) { confirmDelete = true }
                        .disabled(isWorking)
                    if isWorking {
                        ProgressView().frame(maxWidth: .infinity)
                    }
                    if let error {
                        Text(error).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Settings")
            .refreshable { await model.refresh() }
            .confirmationDialog("Sign out on this phone?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button("Sign Out") { run { try await model.signOut() } }
            } message: {
                Text("You will need your account key to sign in again.")
            }
            .confirmationDialog("Delete your account?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete Account", role: .destructive) { run { try await model.deleteAccount() } }
            } message: {
                Text("Your agents, phones and call history are deleted.")
            }
        }
    }

    private func run(_ action: @escaping () async throws -> Void) {
        isWorking = true
        error = nil
        Task {
            defer { isWorking = false }
            do {
                try await action()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

/// Download, choose and remove the on-device voice.
private struct VoiceSection: View {
    private var voice = VoiceModel.shared
    @AppStorage(SpeechVoice.storageKey) private var selected = SpeechVoice.all[0].id
    @State private var confirmDelete = false
    @State private var preview = VoicePreview()

    var body: some View {
        Section {
            switch voice.state {
            case .missing:
                Button("Download Voice") { voice.download() }
            case .downloading(let progress):
                VStack(alignment: .leading, spacing: 8) {
                    ProgressView(value: progress)
                    HStack {
                        Text("Downloading \(Int(progress * 100))%").foregroundStyle(.secondary)
                        Spacer()
                        Button("Cancel") { voice.cancel() }.buttonStyle(.borderless)
                    }
                    .font(.subheadline)
                }
            case .ready:
                Picker("Voice", selection: $selected) {
                    ForEach(SpeechVoice.all) { option in
                        Text("\(option.name) · \(option.detail)").tag(option.id)
                    }
                }
                .pickerStyle(.menu)
                .onChange(of: selected) { preview.play(SpeechVoice.selected) }
                Button {
                    preview.playing == nil ? preview.play(SpeechVoice.selected) : preview.stop()
                } label: {
                    Label(preview.playing == nil ? "Play Sample" : "Stop", systemImage: preview.playing == nil ? "play.fill" : "stop.fill")
                }
                Button("Delete Voice", role: .destructive) { confirmDelete = true }
            case .failed(let message):
                Text(message).foregroundStyle(.red)
                Button("Try Again") { voice.download() }
            }
        } header: {
            Text("Voice")
        } footer: {
            Text("Messages are read on your iPhone with the voice you choose, \(ByteCountFormatter.string(fromByteCount: VoiceModel.totalBytes, countStyle: .file)). Without it, the iOS voice reads them.")
        }
        .confirmationDialog("Delete the voice?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete Voice", role: .destructive) {
                preview.stop()
                voice.delete()
            }
        } message: {
            Text("Messages will be read with the iOS voice until you download it again.")
        }
        .onDisappear { preview.stop() }
    }
}

/// Plays a short sample when a voice is picked.
@MainActor
@Observable
private final class VoicePreview {
    private(set) var playing: String?
    @ObservationIgnored private let player = MessagePlayer()

    func play(_ voice: SpeechVoice) {
        player.stop()
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
        try? AVAudioSession.sharedInstance().setActive(true)
        let id = UUID()
        let text = "Hi, I'm \(voice.name). This is how your agents will sound."
        playing = voice.id
        player.prepareSpeech(id: id, text: text, language: "en")
        player.speak(id: id, text: text, language: "en", onFirstAudio: {}) { [weak self] _, _ in
            if self?.playing == voice.id { self?.playing = nil }
        }
    }

    func stop() {
        player.stop()
        playing = nil
    }
}

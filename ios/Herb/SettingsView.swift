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

/// Download or remove the on-device voice.
private struct VoiceSection: View {
    private var voice = VoiceModel.shared
    @State private var confirmDelete = false

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
                LabeledContent("On-Device Voice", value: "Downloaded")
                Button("Delete Voice", role: .destructive) { confirmDelete = true }
            case .failed(let message):
                Text(message).foregroundStyle(.red)
                Button("Try Again") { voice.download() }
            }
        } header: {
            Text("Voice")
        } footer: {
            Text("Lily reads messages on your iPhone, \(ByteCountFormatter.string(fromByteCount: VoiceModel.totalBytes, countStyle: .file)). Without it, the iOS voice reads them.")
        }
        .confirmationDialog("Delete the voice?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete Voice", role: .destructive) { voice.delete() }
        } message: {
            Text("Messages will be read with the iOS voice until you download it again.")
        }
    }
}

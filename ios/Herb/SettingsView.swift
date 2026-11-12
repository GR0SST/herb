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

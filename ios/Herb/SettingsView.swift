import SwiftUI

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmDelete = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            List {
                if model.pushUnavailable {
                    Label("Calls ring only while Herb is open", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.secondary)
                }
                Section {
                    NavigationLink {
                        ServerView()
                    } label: {
                        LabeledContent("Server", value: model.connection?.baseURL.host() ?? "—")
                    }
                }
                Section {
                    Button("Delete Account", role: .destructive) { confirmDelete = true }
                        .disabled(model.connection == nil)
                    if let error {
                        Text(error).foregroundStyle(.red)
                    }
                }
            }
            .navigationTitle("Settings")
            .refreshable { await model.refresh() }
            .confirmationDialog("Delete your account?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete Account", role: .destructive) {
                    error = nil
                    Task {
                        do {
                            try await model.deleteAccount()
                        } catch {
                            self.error = error.localizedDescription
                        }
                    }
                }
            } message: {
                Text("Your agents and call history are deleted from this server.")
            }
        }
    }
}

/// Свой сервер вместо стандартного. Herb можно развернуть самому.
struct ServerView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var url = ""
    @State private var token = ""
    @State private var isConnecting = false
    @State private var error: String?

    var body: some View {
        Form {
            Section {
                TextField("https://herb.example.com", text: $url)
                    .keyboardType(.URL)
                    .textContentType(.URL)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
                SecureField("Token (optional)", text: $token)
                    .textInputAutocapitalization(.never)
                    .autocorrectionDisabled()
            }
            if let error {
                Section { Text(error).foregroundStyle(.red) }
            }
            Section {
                Button("Connect") { run { try await model.connect(urlString: url, token: token) } }
                    .disabled(isConnecting || url.isEmpty)
                if !model.isDefaultServer {
                    Button("Use \(AppModel.defaultServer.host() ?? "Default Server")") {
                        run { try await model.connect(to: AppModel.defaultServer, token: nil) }
                    }
                    .disabled(isConnecting)
                }
            }
        }
        .navigationTitle("Server")
        .navigationBarTitleDisplayMode(.inline)
        .onAppear {
            if url.isEmpty, !model.isDefaultServer {
                url = model.connection?.baseURL.absoluteString ?? ""
            }
        }
    }

    private func run(_ action: @escaping () async throws -> Void) {
        isConnecting = true
        error = nil
        Task {
            defer { isConnecting = false }
            do {
                try await action()
                dismiss()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

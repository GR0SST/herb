import SwiftUI

/// Shown without an account: create one or sign in with a key.
struct WelcomeView: View {
    @Environment(AppModel.self) private var model
    @State private var key = ""
    @State private var serverText = ""
    @State private var isWorking = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    Button("Create Account") { run { try await model.createAccount() } }
                        .disabled(isWorking)
                }
                Section("Account key") {
                    TextField("ABCD-2345-EFGH-6789-JKMN", text: $key)
                        .textInputAutocapitalization(.characters)
                        .autocorrectionDisabled()
                        .font(.body.monospaced())
                    Button("Sign In") { run { try await model.signIn(key: key) } }
                        .disabled(isWorking || key.trimmingCharacters(in: .whitespaces).isEmpty)
                }
                if let error {
                    Section { Text(error).foregroundStyle(.red) }
                }
                if isWorking {
                    Section { ProgressView().frame(maxWidth: .infinity) }
                }
                Section("Server") {
                    TextField(AppModel.defaultServer.absoluteString, text: $serverText)
                        .keyboardType(.URL)
                        .textContentType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                }
            }
            .navigationTitle("Herb")
            .onAppear {
                if model.signInServer != AppModel.defaultServer { serverText = model.signInServer.absoluteString }
            }
        }
    }

    private func run(_ action: @escaping () async throws -> Void) {
        isWorking = true
        error = nil
        Task {
            defer { isWorking = false }
            do {
                try model.setServer(serverText)
                try await action()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

import SwiftUI

/// Shown without an account: create one or sign in with a key.
struct WelcomeView: View {
    @Environment(AppModel.self) private var model
    @State private var key = ""
    @State private var serverText = ""
    @State private var isWorking = false
    @State private var error: String?
    @State private var showingTour = false

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    VStack(spacing: 12) {
                        Image(systemName: "phone.arrow.down.left.fill")
                            .font(.system(size: 34, weight: .semibold))
                            .foregroundStyle(.white)
                            .frame(width: 72, height: 72)
                            .background(Color.green, in: Circle())
                            .accessibilityHidden(true)
                        Text("Your AI agents can call this iPhone and read their message aloud, or talk it through with you.")
                            .multilineTextAlignment(.center)
                            .foregroundStyle(.secondary)
                        Button("How Herb Works") { showingTour = true }
                            .font(.subheadline)
                    }
                    .frame(maxWidth: .infinity)
                    .listRowBackground(Color.clear)
                }
                Section {
                    Button("Create Account") { run { try await model.createAccount() } }
                        .disabled(isWorking)
                } footer: {
                    Text("Free. No email or password: your account is a key you can use on other devices.")
                }
                Section("Already have an account?") {
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
            .fullScreenCover(isPresented: $showingTour) {
                OnboardingView(replay: true) { showingTour = false }
            }
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

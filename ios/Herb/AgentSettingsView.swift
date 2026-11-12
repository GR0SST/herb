import SwiftUI
import UIKit

/// Call and settings buttons on an agent's screen.
struct AgentToolbar: ToolbarContent {
    @Environment(AppModel.self) private var model
    let bot: Bot
    @State private var editing = false

    var body: some ToolbarContent {
        ToolbarItemGroup(placement: .topBarTrailing) {
            if bot.live != nil {
                Button("Agent Settings", systemImage: "slider.horizontal.3") { editing = true }
                    .sheet(isPresented: $editing) { AgentSettingsView(bot: bot) }
            }
        }
    }
}

/// The top of an agent's screen, like a contact card: picture, name and a big call button.
struct AgentContactCard: View {
    @Environment(AppModel.self) private var model
    let bot: Bot
    @State private var editing = false

    var body: some View {
        VStack(spacing: 10) {
            AgentAvatar(name: bot.name, size: 96)
            Text(bot.name).font(.title2.weight(.semibold))
            if model.status?.live?.available == true {
                Button {
                    if bot.canTakeCalls { model.callCenter.callAgent(bot) } else { editing = true }
                } label: {
                    Label("Call", systemImage: "phone.fill")
                        .font(.headline)
                        .foregroundStyle(.white)
                        .frame(maxWidth: 220, minHeight: 50)
                        .background(bot.canTakeCalls ? Color.green : Color.gray, in: Capsule())
                }
                .buttonStyle(.plain)
                .disabled(model.callCenter.active != nil)
                .padding(.top, 6)
                .sheet(isPresented: $editing) { AgentSettingsView(bot: bot) }
                if !bot.canTakeCalls {
                    Text("Set up a webhook to call \(bot.name)").font(.footnote).foregroundStyle(.secondary)
                }
            }
        }
        .frame(maxWidth: .infinity)
        .padding(.vertical, 12)
    }
}

/// What the voice agent knows and where its events go in a live call.
struct AgentSettingsView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    let bot: Bot
    @State private var instructions = ""
    @State private var webhookURL = ""
    @State private var ownSecret = ""
    @State private var secret: String?
    @State private var copied = false
    @State private var isSaving = false
    @State private var error: String?

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Be brief. Ask before deploying.", text: $instructions, axis: .vertical)
                        .lineLimit(4...10)
                } header: {
                    Text("Instructions")
                } footer: {
                    Text("How the voice agent behaves in every live call with \(bot.name).")
                }
                Section {
                    TextField("https://example.com/herb", text: $webhookURL)
                        .keyboardType(.URL)
                        .textInputAutocapitalization(.never)
                        .autocorrectionDisabled()
                    if secret == nil {
                        SecureField("Signing secret (optional)", text: $ownSecret)
                            .textInputAutocapitalization(.never)
                            .autocorrectionDisabled()
                    }
                    if let secret {
                        Button {
                            UIPasteboard.general.string = secret
                            copied = true
                        } label: {
                            LabeledContent("Secret") {
                                Text(copied ? "Copied" : secret)
                                    .font(.footnote.monospaced())
                                    .multilineTextAlignment(.trailing)
                            }
                        }
                        .foregroundStyle(.primary)
                    }
                } header: {
                    Text("Webhook")
                } footer: {
                    if secret != nil {
                        Text("Copy the secret now. It is shown only once and signs every event.")
                    } else if !ownSecret.isEmpty || bot.live?.webhookURL == nil {
                        Text("Paste the signing secret your service shows for this webhook. Leave it empty and Herb creates one.")
                    } else if bot.live?.listener == true {
                        Text("A listener is connected. It gets events instead of the webhook.")
                    } else {
                        Text("Where \(bot.name)'s live call events go. A connected listener gets them instead.")
                    }
                }
                if let error {
                    Text(error).foregroundStyle(.red)
                }
            }
            .navigationTitle(bot.name)
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .cancellationAction) {
                    Button(secret == nil ? "Cancel" : "Done") { dismiss() }
                }
                if secret == nil {
                    ToolbarItem(placement: .confirmationAction) {
                        Button("Save") { save() }.disabled(isSaving)
                    }
                }
            }
            .onAppear {
                instructions = bot.live?.instructions ?? ""
                webhookURL = bot.live?.webhookURL ?? ""
            }
        }
    }

    private func save() {
        var changes: [String: String?] = [:]
        let cleanInstructions = instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanURL = webhookURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleanInstructions != (bot.live?.instructions ?? "") {
            changes["instructions"] = .some(cleanInstructions.isEmpty ? nil : cleanInstructions)
        }
        if cleanURL != (bot.live?.webhookURL ?? "") {
            changes["webhook_url"] = .some(cleanURL.isEmpty ? nil : cleanURL)
        }
        let cleanSecret = ownSecret.trimmingCharacters(in: .whitespacesAndNewlines)
        if !cleanSecret.isEmpty && !cleanURL.isEmpty {
            changes["webhook_secret"] = .some(cleanSecret)
        }
        guard !changes.isEmpty, let api = model.api else {
            dismiss()
            return
        }
        isSaving = true
        error = nil
        Task {
            defer { isSaving = false }
            do {
                let newSecret = try await api.updateAgent(id: bot.id, changes: changes)
                await model.refresh()
                if let newSecret { secret = newSecret } else { dismiss() }
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

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
    @State private var setup = SetupState.idle

    private enum SetupState: Equatable {
        case idle, working, waiting, saved
        case failed(String)
    }

    /// The agent as the server last reported it: `bot` is a snapshot from when the sheet opened.
    private var current: Bot { model.bots.first { $0.id == bot.id } ?? bot }

    var body: some View {
        NavigationStack {
            Form {
                Section {
                    TextField("Be brief. Ask before deploying.", text: $instructions, axis: .vertical)
                        .lineLimit(4...12)
                } header: {
                    Text("Instructions")
                } footer: {
                    Text("What the voice agent knows at the start of every live call with \(bot.name). Each agent has its own.")
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
                    } else if !ownSecret.isEmpty || current.live?.webhookURL == nil {
                        Text("Paste the signing secret your service shows for this webhook. Leave it empty and Herb creates one.")
                    } else if current.live?.listener == true {
                        Text("A listener is connected. It gets events instead of the webhook.")
                    } else {
                        Text("Where \(bot.name)'s live call events go. A connected listener gets them instead.")
                    }
                }
                if !webhookURL.trimmingCharacters(in: .whitespaces).isEmpty || current.live?.listener == true {
                    Section {
                        Button {
                            runSetup()
                        } label: {
                            HStack {
                                Label("Set Up Instructions", systemImage: "wand.and.stars")
                                Spacer()
                                if setup == .working || setup == .waiting { ProgressView() }
                            }
                        }
                        .disabled(setup == .working || isSaving)
                    } footer: {
                        switch setup {
                        case .idle:
                            Text("Checks the webhook and asks \(bot.name) to write these instructions for itself.")
                        case .working:
                            Text("Checking the webhook…")
                        case .waiting:
                            Text("The webhook works. \(bot.name) is collecting the instructions and will send them shortly.")
                        case .saved:
                            Text("\(bot.name) sent its instructions.")
                        case .failed(let message):
                            Text(message).foregroundStyle(.red)
                        }
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
                instructions = current.live?.instructions ?? ""
                webhookURL = current.live?.webhookURL ?? ""
            }
        }
    }

    private var changes: [String: String?] {
        var changes: [String: String?] = [:]
        let cleanInstructions = instructions.trimmingCharacters(in: .whitespacesAndNewlines)
        let cleanURL = webhookURL.trimmingCharacters(in: .whitespacesAndNewlines)
        if cleanInstructions != (current.live?.instructions ?? "") {
            changes["instructions"] = .some(cleanInstructions.isEmpty ? nil : cleanInstructions)
        }
        if cleanURL != (current.live?.webhookURL ?? "") {
            changes["webhook_url"] = .some(cleanURL.isEmpty ? nil : cleanURL)
        }
        let cleanSecret = ownSecret.trimmingCharacters(in: .whitespacesAndNewlines)
        if !cleanSecret.isEmpty && !cleanURL.isEmpty {
            changes["webhook_secret"] = .some(cleanSecret)
        }
        return changes
    }

    /// Saves pending changes. A new generated secret is shown for copying.
    private func persist() async throws {
        let pending = changes
        guard !pending.isEmpty, let api = model.api else { return }
        if let newSecret = try await api.updateAgent(id: bot.id, changes: pending) { secret = newSecret }
        ownSecret = ""
        await model.refresh()
    }

    private func save() {
        guard !changes.isEmpty else {
            dismiss()
            return
        }
        isSaving = true
        error = nil
        Task {
            defer { isSaving = false }
            do {
                try await persist()
                if secret == nil { dismiss() }
            } catch {
                self.error = error.localizedDescription
            }
        }
    }

    /// Saves the webhook first, then asks the agent for instructions and waits a while for them to arrive.
    private func runSetup() {
        setup = .working
        error = nil
        Task {
            do {
                try await persist()
                guard let api = model.api else { return }
                let before = current.live?.instructions
                switch try await api.setupAgent(id: bot.id) {
                case .saved(let text):
                    instructions = text
                    await model.refresh()
                    setup = .saved
                case .requested:
                    setup = .waiting
                    for _ in 0..<40 {
                        try await Task.sleep(for: .seconds(3))
                        await model.refresh()
                        if let text = current.live?.instructions, text != before {
                            instructions = text
                            setup = .saved
                            return
                        }
                    }
                }
            } catch is CancellationError {
                return
            } catch {
                setup = .failed(error.localizedDescription)
            }
        }
    }
}

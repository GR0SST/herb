import CoreImage.CIFilterBuiltins
import SwiftUI
import UIKit

/// An app that can connect to Herb, with the steps to do it.
struct AgentClient: Identifiable, Hashable {
    struct Step: Hashable {
        let text: String
        /// Text to copy, such as the address or a command.
        var copy: String?
    }

    /// Matches the client names on the website's setup page.
    let id: String
    let name: String
    let summary: String
    let steps: [Step]
    /// The page where the connection is added.
    var page: URL?
    var pageLabel: String?
    /// Set up in a terminal, so better done on a computer.
    var desktopOnly = false

    static func all(mcpURL: String, origin: String) -> [AgentClient] {
        [
            AgentClient(
                id: "chatgpt",
                name: "ChatGPT",
                summary: "Custom connector",
                steps: [
                    Step(text: "Open ChatGPT connectors. Custom servers may need Developer mode in Settings."),
                    Step(text: "Add a custom connector with this address:", copy: mcpURL),
                    Step(text: "Choose OAuth if asked. On the Herb page that opens, sign in and tap Connect."),
                ],
                page: URL(string: "https://chatgpt.com/plugins"),
                pageLabel: "Open ChatGPT"
            ),
            AgentClient(
                id: "claude",
                name: "Claude",
                summary: "Custom connector",
                steps: [
                    Step(text: "Open Claude connectors."),
                    Step(text: "Add a custom connector with this address:", copy: mcpURL),
                    Step(text: "Tap Connect. On the Herb page that opens, sign in and tap Connect."),
                ],
                page: URL(string: "https://claude.ai/customize/connectors"),
                pageLabel: "Open Claude"
            ),
            AgentClient(
                id: "grok",
                name: "Grok Bot",
                summary: "Ask in a chat",
                steps: [
                    Step(text: "In a Grok Bot chat, send:", copy: "Add a custom MCP server called herb at \(mcpURL)"),
                    Step(text: "Confirm with Add it, tap Authorize, then sign in on the Herb page and tap Connect."),
                ]
            ),
            AgentClient(
                id: "codex",
                name: "Codex",
                summary: "One command",
                steps: [
                    Step(text: "Run in a terminal:", copy: "codex mcp add herb --url \(mcpURL)"),
                    Step(text: "On the Herb page that opens, sign in and tap Connect."),
                ],
                desktopOnly: true
            ),
            AgentClient(
                id: "claude-code",
                name: "Claude Code",
                summary: "One command",
                steps: [
                    Step(text: "Run in a terminal:", copy: "claude mcp add --transport http herb \(mcpURL)"),
                    Step(text: "Run /mcp in Claude Code, then sign in on the Herb page and tap Connect."),
                ],
                desktopOnly: true
            ),
            AgentClient(
                id: "script",
                name: "Script or Other App",
                summary: "HTTP API with a token",
                steps: [
                    Step(text: "Create an API token below, then call:", copy: "curl -X POST \(origin)/v1/call -H \"Authorization: Bearer $TOKEN\""),
                    Step(text: "Add a JSON body with \"text\" to have the message read aloud. The docs list every option."),
                ],
                page: URL(string: "\(origin)/docs"),
                pageLabel: "Open the Docs",
                desktopOnly: true
            ),
        ]
    }
}

/// Connect an agent: steps for each app, a link to finish on a computer, and tokens for scripts.
struct ConnectAgentView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss

    var body: some View {
        NavigationStack {
            List {
                Section {
                    SetUpOnComputerButton(client: nil)
                } footer: {
                    Text("Most agents run on a computer. This opens the Herb website there, already signed in, with the steps for each agent.")
                }
                Section("Choose your agent") {
                    ForEach(model.agentClients) { client in
                        NavigationLink(value: client) {
                            HStack(spacing: 12) {
                                ClientIcon(client: client, size: 36)
                                VStack(alignment: .leading, spacing: 2) {
                                    Text(client.name)
                                    Text(client.summary).font(.footnote).foregroundStyle(.secondary)
                                }
                            }
                        }
                    }
                }
                Section {
                    CopyRow(value: model.mcpURL)
                } header: {
                    Text("MCP server")
                } footer: {
                    Text("Any app that supports MCP connects with this address.")
                }
            }
            .navigationTitle("Connect Agent")
            .navigationBarTitleDisplayMode(.inline)
            .navigationDestination(for: AgentClient.self) { ClientGuideView(client: $0) }
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
    }
}

struct ClientIcon: View {
    let client: AgentClient
    var size: CGFloat = 36

    var body: some View {
        if client.id == "script" {
            Image(systemName: "terminal")
                .font(.system(size: size * 0.42, weight: .semibold))
                .foregroundStyle(Color(.systemBackground))
                .frame(width: size, height: size)
                .background(Color.primary, in: Circle())
                .accessibilityHidden(true)
        } else {
            AgentAvatar(name: client.name, size: size)
        }
    }
}

/// Steps for one app.
private struct ClientGuideView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.openURL) private var openURL
    let client: AgentClient

    var body: some View {
        List {
            Section {
                HStack(spacing: 12) {
                    ClientIcon(client: client, size: 48)
                    Text(client.desktopOnly ? "Set this up on the computer where \(client.name) runs." : "Works on this iPhone or on a computer.")
                        .font(.subheadline)
                        .foregroundStyle(.secondary)
                }
                .listRowBackground(Color.clear)
                .listRowInsets(EdgeInsets())
            }
            Section("Steps") {
                ForEach(Array(client.steps.enumerated()), id: \.offset) { index, step in
                    VStack(alignment: .leading, spacing: 8) {
                        HStack(alignment: .firstTextBaseline, spacing: 10) {
                            Text("\(index + 1)")
                                .font(.caption.weight(.bold).monospacedDigit())
                                .foregroundStyle(Color(.systemBackground))
                                .frame(width: 22, height: 22)
                                .background(Color.accentColor, in: Circle())
                            Text(step.text)
                        }
                        if let copy = step.copy {
                            CopyRow(value: copy).padding(.leading, 32)
                        }
                    }
                    .padding(.vertical, 4)
                }
            }
            if client.id == "script" {
                TokenSection()
            } else if let key = model.accountKey {
                Section {
                    CopyRow(value: key)
                } header: {
                    Text("Account key")
                } footer: {
                    Text("The Herb page asks for it when the browser is not signed in yet.")
                }
            }
            Section {
                if let page = client.page, let label = client.pageLabel {
                    Button {
                        openURL(page)
                    } label: {
                        Label(label, systemImage: "arrow.up.right.square")
                    }
                }
                SetUpOnComputerButton(client: client)
            } footer: {
                Text("After you connect, the agent shows up in Agents. Ask it to call you to try it.")
            }
        }
        .navigationTitle(client.name)
        .navigationBarTitleDisplayMode(.inline)
    }
}

/// An API token for a script or an app without browser sign-in.
private struct TokenSection: View {
    @Environment(AppModel.self) private var model
    @State private var name = ""
    @State private var token: String?
    @State private var tokenError: String?
    @State private var isCreating = false

    var body: some View {
        Section {
            if let token {
                CopyRow(value: token)
            } else {
                TextField("Agent name", text: $name)
                    .textInputAutocapitalization(.words)
                    .autocorrectionDisabled()
                Button("Create Token") { createToken() }
                    .disabled(isCreating || name.trimmingCharacters(in: .whitespaces).isEmpty)
            }
            if let tokenError {
                Text(tokenError).foregroundStyle(.red)
            }
        } header: {
            Text("API token")
        } footer: {
            Text(token == nil ? "Each token is a separate agent." : "Copy it now. It is shown only once.")
        }
    }

    private func createToken() {
        isCreating = true
        tokenError = nil
        Task {
            defer { isCreating = false }
            do {
                token = try await model.createAgent(name: name.trimmingCharacters(in: .whitespaces))
            } catch {
                tokenError = error.localizedDescription
            }
        }
    }
}

/// Makes a one-time setup link and shows it as a QR code to share with a computer.
struct SetUpOnComputerButton: View {
    @Environment(AppModel.self) private var model
    let client: AgentClient?
    @State private var link: URL?
    @State private var isLoading = false
    @State private var error: String?

    var body: some View {
        Button {
            load()
        } label: {
            HStack {
                Label(client == nil ? "Set Up on a Computer" : "Send These Steps to a Computer", systemImage: "laptopcomputer.and.arrow.down")
                Spacer()
                if isLoading { ProgressView() }
            }
        }
        .disabled(isLoading)
        .sheet(item: $link) { SetupLinkView(link: $0, onRenew: { await fetch() }) }
        if let error {
            Text(error).foregroundStyle(.red)
        }
    }

    private func load() {
        isLoading = true
        error = nil
        Task {
            defer { isLoading = false }
            link = await fetch()
        }
    }

    private func fetch() async -> URL? {
        guard let api = model.api else { return nil }
        do {
            return try await api.setupLink(client: client?.id)
        } catch {
            self.error = error.localizedDescription
            return nil
        }
    }
}

extension URL: @retroactive Identifiable {
    public var id: String { absoluteString }
}

private struct SetupLinkView: View {
    @Environment(\.dismiss) private var dismiss
    @State var link: URL
    let onRenew: () async -> URL?
    @State private var copied = false

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 20) {
                    Text("Scan with the computer's camera, or send the link to yourself. It opens the Herb website signed in to this account.")
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.secondary)
                    QRCode(text: link.absoluteString)
                        .frame(width: 220, height: 220)
                        .padding(16)
                        .background(Color.white, in: RoundedRectangle(cornerRadius: 20))
                        .accessibilityLabel("QR code of the setup link")
                    ShareLink(item: link) {
                        Label("Send Link", systemImage: "square.and.arrow.up")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.borderedProminent)
                    .foregroundStyle(Color(.systemBackground))
                    .controlSize(.large)
                    Button {
                        UIPasteboard.general.url = link
                        copied = true
                    } label: {
                        Label(copied ? "Copied" : "Copy Link", systemImage: copied ? "checkmark" : "doc.on.doc")
                            .frame(maxWidth: .infinity)
                    }
                    .buttonStyle(.bordered)
                    .controlSize(.large)
                    Text("The link works once, for 15 minutes. Send it only to yourself: anyone who opens it can connect agents to your phone.")
                        .font(.footnote)
                        .multilineTextAlignment(.center)
                        .foregroundStyle(.secondary)
                    Button("New Link") {
                        Task {
                            if let fresh = await onRenew() {
                                link = fresh
                                copied = false
                            }
                        }
                    }
                    .font(.footnote)
                }
                .padding(24)
            }
            .navigationTitle("Set Up on a Computer")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
        }
        .presentationDetents([.large])
    }
}

private struct QRCode: View {
    let text: String

    var body: some View {
        if let image = Self.render(text) {
            Image(uiImage: image).interpolation(.none).resizable().scaledToFit()
        } else {
            Color.clear
        }
    }

    private static func render(_ text: String) -> UIImage? {
        let filter = CIFilter.qrCodeGenerator()
        filter.message = Data(text.utf8)
        filter.correctionLevel = "M"
        guard let output = filter.outputImage,
              let cgImage = CIContext().createCGImage(output, from: output.extent)
        else { return nil }
        return UIImage(cgImage: cgImage)
    }
}

struct CopyRow: View {
    let value: String
    @State private var copied = false

    var body: some View {
        Button {
            UIPasteboard.general.string = value
            copied = true
        } label: {
            HStack {
                Text(value)
                    .font(.footnote.monospaced())
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.leading)
                Spacer()
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
            }
        }
        .buttonStyle(.borderless)
        .accessibilityLabel(copied ? "Copied" : "Copy \(value)")
    }
}

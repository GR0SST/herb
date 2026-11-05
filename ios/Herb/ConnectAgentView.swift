import SwiftUI
import UIKit

/// Connect an agent: the MCP address for plugins or a token for scripts.
struct ConnectAgentView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var name = ""
    @State private var token: String?
    @State private var tokenError: String?
    @State private var isCreating = false

    private var mcpURL: String {
        model.status?.mcpURL ?? model.connection?.baseURL.appending(path: "mcp").absoluteString ?? ""
    }

    var body: some View {
        NavigationStack {
            Form {
                Section("MCP server") {
                    CopyRow(value: mcpURL)
                }
                Section("API token") {
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
                }
            }
            .navigationTitle("Connect Agent")
            .navigationBarTitleDisplayMode(.inline)
            .toolbar {
                ToolbarItem(placement: .confirmationAction) {
                    Button("Done") { dismiss() }
                }
            }
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

private struct CopyRow: View {
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
        .accessibilityLabel(copied ? "Copied" : "Copy \(value)")
    }
}

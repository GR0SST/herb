import SwiftUI
import UIKit

/// Подключение агента: код для страницы входа плагина или токен для скрипта.
struct ConnectAgentView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var code: String?
    @State private var codeError: String?
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
                Section("Sign-in code") {
                    if let code {
                        CopyRow(value: code, font: .title2.monospaced().weight(.semibold))
                    } else if let codeError {
                        Text(codeError).foregroundStyle(.red)
                    } else {
                        ProgressView()
                    }
                    Button("New Code") { Task { await loadCode() } }
                }
                Section("MCP server") {
                    CopyRow(value: mcpURL, font: .footnote.monospaced())
                }
                Section("API token") {
                    if let token {
                        CopyRow(value: token, font: .footnote.monospaced())
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
            .task { await loadCode() }
        }
    }

    private func loadCode() async {
        code = nil
        codeError = nil
        guard let api = model.api else { return }
        do {
            code = try await api.connectCode()
        } catch {
            codeError = error.localizedDescription
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
    let font: Font
    @State private var copied = false

    var body: some View {
        Button {
            UIPasteboard.general.string = value
            copied = true
        } label: {
            HStack {
                Text(value)
                    .font(font)
                    .foregroundStyle(.primary)
                    .multilineTextAlignment(.leading)
                    .textSelection(.enabled)
                Spacer()
                Image(systemName: copied ? "checkmark" : "doc.on.doc")
            }
        }
        .accessibilityLabel(copied ? "Copied" : "Copy \(value)")
    }
}

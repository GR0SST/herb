import Foundation
import Observation

/// Chat history with one agent. Stored only on the phone.
@MainActor
@Observable
final class ChatStore {
    private(set) var messages: [ChatMessage] = []
    private(set) var isStreaming = false
    var errorMessage: String?

    @ObservationIgnored private let bot: Bot
    @ObservationIgnored private let api: API
    @ObservationIgnored private var task: Task<Void, Never>?
    private static let contextLimit = 40

    init(bot: Bot, api: API) {
        self.bot = bot
        self.api = api
        load()
    }

    private var fileURL: URL {
        let dir = URL.applicationSupportDirectory.appending(path: "chats", directoryHint: .isDirectory)
        try? FileManager.default.createDirectory(at: dir, withIntermediateDirectories: true)
        return dir.appending(path: "\(bot.id).json")
    }

    private func load() {
        guard let data = try? Data(contentsOf: fileURL),
              let saved = try? JSONDecoder().decode([ChatMessage].self, from: data)
        else { return }
        messages = saved
    }

    private func save() {
        guard let data = try? JSONEncoder().encode(messages) else { return }
        try? data.write(to: fileURL, options: [.atomic, .completeFileProtectionUntilFirstUserAuthentication])
    }

    func send(_ text: String) {
        let trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !trimmed.isEmpty, !isStreaming else { return }
        messages.append(ChatMessage(role: .user, content: trimmed))
        save()
        stream()
    }

    /// Retry after an error: the last user message is already in the history.
    func retry() {
        guard !isStreaming, messages.last?.role == .user else { return }
        stream()
    }

    func stop() {
        task?.cancel()
    }

    func clear() {
        stop()
        messages = []
        errorMessage = nil
        save()
    }

    private func stream() {
        errorMessage = nil
        isStreaming = true
        let context = Array(messages.suffix(Self.contextLimit))
        let replyID = UUID()
        task = Task {
            defer {
                isStreaming = false
                messages.removeAll { $0.id == replyID && $0.content.isEmpty }
                save()
            }
            do {
                for try await delta in api.chat(botID: bot.id, messages: context) {
                    if let index = messages.firstIndex(where: { $0.id == replyID }) {
                        messages[index].content += delta
                    } else {
                        messages.append(ChatMessage(id: replyID, role: .assistant, content: delta))
                    }
                }
            } catch is CancellationError {
                return
            } catch let error as URLError where error.code == .cancelled {
                return
            } catch {
                errorMessage = error.localizedDescription
            }
        }
    }
}

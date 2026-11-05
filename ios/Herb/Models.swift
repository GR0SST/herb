import Foundation

struct Bot: Codable, Identifiable, Hashable {
    struct Capabilities: Codable, Hashable {
        let chat: Bool
        let calls: Bool
    }

    let id: String
    let name: String
    let capabilities: Capabilities
}

enum CallStatus: String, Codable {
    case ringing, answered, played, declined, missed, failed

    var label: String {
        switch self {
        case .ringing: "Ringing"
        case .answered: "Answered"
        case .played: "Played"
        case .declined: "Declined"
        case .missed: "Missed"
        case .failed: "Failed"
        }
    }
}

struct CallRecord: Codable, Identifiable, Hashable {
    let id: String
    let botId: String
    let botName: String
    let title: String?
    let text: String?
    let language: String?
    let hasAudio: Bool
    let status: CallStatus
    let createdAt: Double

    var date: Date { Date(timeIntervalSince1970: createdAt / 1000) }

    enum CodingKeys: String, CodingKey {
        case id, title, text, language, status
        case botId = "bot_id"
        case botName = "bot_name"
        case hasAudio = "has_audio"
        case createdAt = "created_at"
    }
}

struct ChatMessage: Codable, Identifiable, Hashable {
    enum Role: String, Codable { case user, assistant }

    var id = UUID()
    let role: Role
    var content: String
}

extension String {
    /// Текст без знаков ударения: они нужны синтезатору, а не для чтения.
    var withoutStressMarks: String { replacingOccurrences(of: "\u{301}", with: "") }
}

struct RelayStatus: Codable {
    let pushEnabled: Bool
    let pushRegistered: Bool
    let mcpURL: String?

    enum CodingKeys: String, CodingKey {
        case pushEnabled = "push_enabled"
        case pushRegistered = "push_registered"
        case mcpURL = "mcp_url"
    }
}

struct NewAgent: Codable {
    let token: String
}

struct ConnectCode: Codable {
    let code: String
}

struct Connection: Equatable {
    let baseURL: URL
    let token: String
}

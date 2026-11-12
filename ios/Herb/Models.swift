import Foundation

struct Bot: Codable, Identifiable, Hashable {
    struct Capabilities: Codable, Hashable {
        let chat: Bool
        let calls: Bool
    }

    /// Live call settings. Missing on servers without live calls.
    struct Live: Codable, Hashable {
        let instructions: String?
        let webhookURL: String?
        let listener: Bool

        enum CodingKeys: String, CodingKey {
            case instructions, listener
            case webhookURL = "webhook_url"
        }
    }

    let id: String
    let name: String
    let capabilities: Capabilities
    let live: Live?

    /// Something receives the agent's live call events: a webhook or a connected listener.
    var canTakeCalls: Bool { live?.webhookURL != nil || live?.listener == true }
}

enum CallStatus: String, Codable {
    case ringing, answered, played, ended, declined, missed, failed

    var label: String {
        switch self {
        case .ringing: "Ringing"
        case .answered: "Answered"
        case .played: "Played"
        case .ended: "Ended"
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
    /// A two-way call. Missing on older servers.
    let live: Bool?
    /// The user called the agent. Missing on older servers.
    let outgoing: Bool?
    let createdAt: Double

    var date: Date { Date(timeIntervalSince1970: createdAt / 1000) }

    enum CodingKeys: String, CodingKey {
        case id, title, text, language, status, live, outgoing
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
    /// Text without stress marks, which are for the voice model and not for reading.
    var withoutStressMarks: String { replacingOccurrences(of: "\u{301}", with: "") }
}

struct RelayStatus: Codable {
    struct Live: Codable {
        let available: Bool
        let billing: Bool
        let secondsLeft: Int?

        enum CodingKeys: String, CodingKey {
            case available, billing
            case secondsLeft = "seconds_left"
        }
    }

    let pushEnabled: Bool
    let pushRegistered: Bool
    let mcpURL: String?
    let live: Live?

    enum CodingKeys: String, CodingKey {
        case live
        case pushEnabled = "push_enabled"
        case pushRegistered = "push_registered"
        case mcpURL = "mcp_url"
    }
}

struct NewAgent: Codable {
    let token: String
}

struct LiveStart: Decodable {
    struct Voice: Decodable { let sdp: String }
    let call: CallRecord
    let voice: Voice
}



struct Connection: Equatable {
    let baseURL: URL
    let token: String
}

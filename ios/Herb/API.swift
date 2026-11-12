import Foundation

enum APIError: LocalizedError {
    case message(String)
    case unauthorized
    /// A live call without minutes left: the app shows its plans.
    case noMinutes

    var errorDescription: String? {
        switch self {
        case .message(let text): text
        case .noMinutes: "No live call minutes left"
        case .unauthorized: "This account no longer exists on the server"
        }
    }
}

struct API {
    let connection: Connection

    private struct ErrorBody: Decodable {
        struct Inner: Decodable { let message: String }
        let error: Inner
    }

    private func request(_ path: String, method: String = "GET", body: (any Encodable)? = nil) throws -> URLRequest {
        var request = URLRequest(url: connection.baseURL.appending(path: path))
        request.httpMethod = method
        request.timeoutInterval = 20
        request.setValue("Bearer \(connection.token)", forHTTPHeaderField: "Authorization")
        if let body {
            request.setValue("application/json", forHTTPHeaderField: "Content-Type")
            request.httpBody = try JSONEncoder().encode(body)
        }
        return request
    }

    fileprivate func check(_ response: URLResponse, _ data: Data) throws {
        guard let http = response as? HTTPURLResponse else { throw APIError.message("No response from the server") }
        guard (200..<300).contains(http.statusCode) else {
            if http.statusCode == 401 { throw APIError.unauthorized }
            if http.statusCode == 402 { throw APIError.noMinutes }
            if let parsed = try? JSONDecoder().decode(ErrorBody.self, from: data) {
                throw APIError.message(parsed.error.message)
            }
            throw APIError.message("Server error \(http.statusCode)")
        }
    }

    private func send(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await URLSession.shared.data(for: request)
        try check(response, data)
        return data
    }

    private struct NewSession: Decodable {
        let token: String
        let key: String?
    }

    private static func openSession(at baseURL: URL, path: String, body: [String: String]) async throws -> NewSession {
        var request = URLRequest(url: baseURL.appending(path: path))
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONEncoder().encode(body)
        let (data, response) = try await URLSession.shared.data(for: request)
        // Here 401 means a wrong key, not a missing account.
        if (response as? HTTPURLResponse)?.statusCode == 401 { throw APIError.message("Wrong account key") }
        try API(connection: Connection(baseURL: baseURL, token: "")).check(response, data)
        return try JSONDecoder().decode(NewSession.self, from: data)
    }

    /// New account: the server returns the key and a token for this phone.
    static func createAccount(at baseURL: URL, deviceName: String) async throws -> (key: String, token: String) {
        let session = try await openSession(at: baseURL, path: "v1/accounts", body: ["device_name": deviceName])
        guard let key = session.key else { throw APIError.message("The server returned no account key") }
        return (key, session.token)
    }

    static func signIn(at baseURL: URL, key: String, deviceName: String) async throws -> String {
        try await openSession(at: baseURL, path: "v1/sessions", body: ["key": key, "device_name": deviceName]).token
    }

    func deleteAccount() async throws {
        _ = try await send(request("v1/account", method: "DELETE"))
    }

    func signOut() async throws {
        _ = try await send(request("v1/device", method: "DELETE"))
    }

    func createAgent(name: String) async throws -> String {
        struct Body: Encodable { let name: String }
        return try JSONDecoder().decode(NewAgent.self, from: await send(request("v1/bots", method: "POST", body: Body(name: name)))).token
    }

    func deleteAgent(id: String) async throws {
        _ = try await send(request("v1/bots/\(id)", method: "DELETE"))
    }

    /// The phone calls an agent: the server returns the call and GPT-Live's WebRTC answer.
    func startLive(botID: String, sdp: String) async throws -> LiveStart {
        struct Body: Encodable { let bot_id: String; let sdp: String }
        var req = try request("v1/live", method: "POST", body: Body(bot_id: botID, sdp: sdp))
        // The server first asks the agent's handler for context.
        req.timeoutInterval = 30
        return try JSONDecoder().decode(LiveStart.self, from: await send(req))
    }

    /// Joins an agent's live call after answering it.
    func joinLive(callID: String, sdp: String) async throws -> LiveStart {
        struct Body: Encodable { let sdp: String }
        var req = try request("v1/calls/\(callID)/live", method: "POST", body: Body(sdp: sdp))
        req.timeoutInterval = 30
        return try JSONDecoder().decode(LiveStart.self, from: await send(req))
    }

    func endLive(callID: String) async throws {
        _ = try await send(request("v1/calls/\(callID)/end", method: "POST"))
    }

    /// Sends only changed fields: a nil value clears the setting. A new webhook URL returns its secret, shown once.
    func updateAgent(id: String, changes: [String: String?]) async throws -> String? {
        struct Reply: Decodable { let webhook_secret: String? }
        let data = try await send(request("v1/bots/\(id)", method: "PATCH", body: changes))
        return try JSONDecoder().decode(Reply.self, from: data).webhook_secret
    }

    enum SetupResult {
        case saved(String)
        case requested
    }

    /// Sends agent.setup to the agent's webhook. Throws the delivery problem, such as an HTTP error.
    func setupAgent(id: String) async throws -> SetupResult {
        struct Reply: Decodable { let status: String; let instructions: String? }
        var req = try request("v1/bots/\(id)/setup", method: "POST")
        req.timeoutInterval = 30
        let reply = try JSONDecoder().decode(Reply.self, from: await send(req))
        if reply.status == "saved", let text = reply.instructions { return .saved(text) }
        return .requested
    }

    /// Sends a signed App Store transaction, so the server counts its minutes for this account.
    func sendTransaction(_ jws: String) async throws {
        struct Body: Encodable { let jws: String }
        _ = try await send(request("v1/billing/transactions", method: "POST", body: Body(jws: jws)))
    }

    func status() async throws -> RelayStatus {
        try JSONDecoder().decode(RelayStatus.self, from: await send(request("v1/status")))
    }

    func bots() async throws -> [Bot] {
        struct Body: Decodable { let bots: [Bot] }
        return try JSONDecoder().decode(Body.self, from: await send(request("v1/bots"))).bots
    }

    func calls(botID: String? = nil) async throws -> [CallRecord] {
        struct Body: Decodable { let calls: [CallRecord] }
        var req = try request("v1/calls")
        if let botID {
            req.url = req.url?.appending(queryItems: [URLQueryItem(name: "bot_id", value: botID)])
        }
        return try JSONDecoder().decode(Body.self, from: await send(req)).calls
    }

    func pendingCalls() async throws -> [CallRecord] {
        struct Body: Decodable { let calls: [CallRecord] }
        return try JSONDecoder().decode(Body.self, from: await send(request("v1/calls/pending"))).calls
    }

    func call(id: UUID) async throws -> CallRecord {
        try JSONDecoder().decode(CallRecord.self, from: await send(request("v1/calls/\(id.uuidString.lowercased())")))
    }

    func audio(callID: UUID) async throws -> Data {
        try await send(request("v1/calls/\(callID.uuidString.lowercased())/audio"))
    }

    func setStatus(callID: UUID, _ status: CallStatus) async throws {
        struct Body: Encodable { let status: String }
        _ = try await send(request("v1/calls/\(callID.uuidString.lowercased())/status", method: "POST", body: Body(status: status.rawValue)))
    }

    func registerPush(token: String, environment: String) async throws {
        struct Body: Encodable {
            let voip_token: String
            let environment: String
        }
        _ = try await send(request("v1/device", method: "PUT", body: Body(voip_token: token, environment: environment)))
    }

    /// The agent's reply in chunks: the server proxies an OpenAI-compatible stream.
    func chat(botID: String, messages: [ChatMessage]) -> AsyncThrowingStream<String, Error> {
        struct Wire: Encodable { let role: String; let content: String }
        struct Body: Encodable { let messages: [Wire] }
        let body = Body(messages: messages.map { Wire(role: $0.role.rawValue, content: $0.content) })

        return AsyncThrowingStream { continuation in
            let task = Task {
                do {
                    var req = try request("v1/bots/\(botID)/chat", method: "POST", body: body)
                    req.timeoutInterval = 300
                    let (bytes, response) = try await URLSession.shared.bytes(for: req)
                    if let http = response as? HTTPURLResponse, !(200..<300).contains(http.statusCode) {
                        var data = Data()
                        for try await byte in bytes.prefix(4096) { data.append(byte) }
                        try check(response, data)
                    }
                    for try await line in bytes.lines {
                        if let delta = SSE.delta(from: line) {
                            continuation.yield(delta)
                        }
                    }
                    continuation.finish()
                } catch {
                    continuation.finish(throwing: error)
                }
            }
            continuation.onTermination = { _ in task.cancel() }
        }
    }
}

enum SSE {
    private struct Chunk: Decodable {
        struct Choice: Decodable {
            struct Delta: Decodable { let content: String? }
            let delta: Delta?
        }
        let choices: [Choice]
    }

    static func delta(from line: String) -> String? {
        guard line.hasPrefix("data:") else { return nil }
        let payload = line.dropFirst(5).trimmingCharacters(in: .whitespaces)
        guard payload != "[DONE]", let data = payload.data(using: .utf8),
              let chunk = try? JSONDecoder().decode(Chunk.self, from: data)
        else { return nil }
        return chunk.choices.first?.delta?.content
    }
}

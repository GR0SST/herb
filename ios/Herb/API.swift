import Foundation

enum APIError: LocalizedError {
    case message(String)
    case unauthorized

    var errorDescription: String? {
        switch self {
        case .message(let text): text
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

    /// Новый аккаунт на сервере: токена ещё нет, поэтому запрос без авторизации.
    static func register(at baseURL: URL) async throws -> String {
        struct Body: Decodable { let token: String }
        var request = URLRequest(url: baseURL.appending(path: "v1/register"))
        request.httpMethod = "POST"
        request.timeoutInterval = 20
        let (data, response) = try await URLSession.shared.data(for: request)
        let probe = API(connection: Connection(baseURL: baseURL, token: ""))
        try probe.check(response, data)
        return try JSONDecoder().decode(Body.self, from: data).token
    }

    func deleteAccount() async throws {
        _ = try await send(request("v1/device", method: "DELETE"))
    }

    func createAgent(name: String) async throws -> String {
        struct Body: Encodable { let name: String }
        return try JSONDecoder().decode(NewAgent.self, from: await send(request("v1/bots", method: "POST", body: Body(name: name)))).token
    }

    func deleteAgent(id: String) async throws {
        _ = try await send(request("v1/bots/\(id)", method: "DELETE"))
    }

    func connectCode() async throws -> String {
        try JSONDecoder().decode(ConnectCode.self, from: await send(request("v1/connect-codes", method: "POST"))).code
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

    /// Ответ бота частями: сервер проксирует поток OpenAI-совместимого API.
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

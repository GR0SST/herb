import Foundation
import Observation

@MainActor
@Observable
final class AppModel {
    nonisolated static let defaultServer = URL(string: "https://herb.grosst.cc")!

    private(set) var connection: Connection?
    private(set) var bots: [Bot] = []
    private(set) var calls: [CallRecord] = []
    private(set) var status: RelayStatus?
    var errorMessage: String?

    let callCenter = CallCenter()

    #if DEBUG
    private let pushEnvironment = "sandbox"
    #else
    private let pushEnvironment = "production"
    #endif

    var api: API? { connection.map(API.init) }
    var isDefaultServer: Bool { connection?.baseURL == Self.defaultServer }

    /// Пуши работают сами. Показываем их только когда звонок не дойдёт до закрытого приложения.
    var pushUnavailable: Bool {
        guard let status else { return false }
        return !status.pushEnabled || !status.pushRegistered
    }

    init() {
        connection = ConnectionStore.load()
        callCenter.api = { [weak self] in self?.api }
        callCenter.onVoipToken = { [weak self] _ in
            Task { await self?.uploadPushToken() }
        }
        callCenter.onCallFinished = { [weak self] in
            Task { await self?.refresh() }
        }
        callCenter.start()
    }

    /// Аккаунт появляется сам при первом запуске, без настройки.
    func ensureAccount() async {
        guard connection == nil else { return }
        do {
            try await connect(to: Self.defaultServer, token: nil)
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Свой сервер: токен необязателен, если там открыта регистрация.
    func connect(urlString: String, token: String) async throws {
        var trimmed = urlString.trimmingCharacters(in: .whitespacesAndNewlines)
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http", url.host() != nil
        else { throw APIError.message("Enter a full address, like https://herb.example.com") }
        let cleanToken = token.trimmingCharacters(in: .whitespacesAndNewlines)
        try await connect(to: url, token: cleanToken.isEmpty ? nil : cleanToken)
    }

    func connect(to url: URL, token: String?) async throws {
        var resolved = token ?? ConnectionStore.token(for: url)
        if resolved == nil { resolved = try await API.register(at: url) }
        var candidate = Connection(baseURL: url, token: resolved!)
        do {
            status = try await API(connection: candidate).status()
        } catch APIError.unauthorized where token == nil {
            // Аккаунт удалён на сервере: создаём новый.
            candidate = Connection(baseURL: url, token: try await API.register(at: url))
            status = try await API(connection: candidate).status()
        }
        try ConnectionStore.save(candidate)
        connection = candidate
        bots = []
        calls = []
        errorMessage = nil
        await uploadPushToken()
        await refresh()
    }

    /// Удаляет данные на сервере и сразу заводит чистый аккаунт на том же сервере.
    func deleteAccount() async throws {
        guard let api, let url = connection?.baseURL else { return }
        try await api.deleteAccount()
        ConnectionStore.removeToken(for: url)
        connection = nil
        try? FileManager.default.removeItem(at: URL.applicationSupportDirectory.appending(path: "chats", directoryHint: .isDirectory))
        try await connect(to: url, token: nil)
    }

    func createAgent(name: String) async throws -> String {
        guard let api else { throw APIError.message("No connection to the server") }
        let token = try await api.createAgent(name: name)
        await refresh()
        return token
    }

    func deleteAgent(_ bot: Bot) async {
        guard let api else { return }
        do {
            try await api.deleteAgent(id: bot.id)
            await refresh()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func refresh() async {
        guard let api else { return }
        do {
            async let bots = api.bots()
            async let calls = api.calls()
            async let status = api.status()
            (self.bots, self.calls, self.status) = try await (bots, calls, status)
            errorMessage = nil
        } catch is CancellationError {
            return
        } catch let error as URLError where error.code == .cancelled {
            return
        } catch APIError.unauthorized {
            // Аккаунт удалён на сервере: заводим новый.
            if let url = connection?.baseURL {
                ConnectionStore.removeToken(for: url)
                connection = nil
                try? await connect(to: url, token: nil)
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func calls(for bot: Bot) -> [CallRecord] {
        calls.filter { $0.botId == bot.id }
    }

    /// Пока приложение открыто, звонки приходят и без пушей.
    func pollWhileActive() async {
        while !Task.isCancelled {
            if let api, let pending = try? await api.pendingCalls() {
                pending.forEach(callCenter.reportIfNew)
            }
            try? await Task.sleep(for: .seconds(4))
        }
    }

    private func uploadPushToken() async {
        guard let api, let token = callCenter.voipToken else { return }
        do {
            try await api.registerPush(token: token, environment: pushEnvironment)
            status = try await api.status()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

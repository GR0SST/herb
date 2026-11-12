import Foundation
import Observation
import UIKit

@MainActor
@Observable
final class AppModel {
    nonisolated static let defaultServer = URL(string: "https://herb.grosst.cc")!

    private(set) var connection: Connection?
    private(set) var bots: [Bot] = []
    private(set) var calls: [CallRecord] = []
    private(set) var status: RelayStatus?
    /// Server for the sign-in screen. Can be replaced with your own.
    var signInServer = AppModel.defaultServer
    var errorMessage: String?

    let callCenter = CallCenter()
    let purchases = Purchases()
    /// Subscriptions are sent once per launch and after each sign-in.
    @ObservationIgnored private var sentEntitlements = false

    #if DEBUG
    private let pushEnvironment = "sandbox"
    #else
    private let pushEnvironment = "production"
    #endif

    var api: API? { connection.map(API.init) }
    var accountKey: String? { connection.flatMap { ConnectionStore.accountKey(for: $0.baseURL) } }

    /// Push works on its own. Mention it only when a call would not reach a closed app.
    var pushUnavailable: Bool {
        guard let status else { return false }
        return !status.pushEnabled || !status.pushRegistered
    }

    init() {
        connection = ConnectionStore.load()
        if let connection { signInServer = connection.baseURL }
        callCenter.api = { [weak self] in self?.api }
        callCenter.onVoipToken = { [weak self] _ in
            Task { await self?.uploadPushToken() }
        }
        callCenter.onCallFinished = { [weak self] in
            Task { await self?.refresh() }
        }
        callCenter.start()
        purchases.api = { [weak self] in self?.api }
        purchases.onChange = { [weak self] in
            Task { await self?.refresh() }
        }
        purchases.start()
    }

    private var deviceName: String { UIDevice.current.model }

    func createAccount() async throws {
        let created = try await API.createAccount(at: signInServer, deviceName: deviceName)
        try await finishSignIn(token: created.token, key: created.key)
    }

    func signIn(key: String) async throws {
        let clean = key.trimmingCharacters(in: .whitespacesAndNewlines)
        let token = try await API.signIn(at: signInServer, key: clean, deviceName: deviceName)
        try await finishSignIn(token: token, key: clean)
    }

    /// Custom server address for the sign-in screen.
    func setServer(_ text: String) throws {
        var trimmed = text.trimmingCharacters(in: .whitespacesAndNewlines)
        while trimmed.hasSuffix("/") { trimmed.removeLast() }
        guard !trimmed.isEmpty else {
            signInServer = Self.defaultServer
            return
        }
        guard let url = URL(string: trimmed), let scheme = url.scheme?.lowercased(),
              scheme == "https" || scheme == "http", url.host() != nil
        else { throw APIError.message("Enter a full address, like https://herb.example.com") }
        signInServer = url
    }

    private func finishSignIn(token: String, key: String) async throws {
        let candidate = Connection(baseURL: signInServer, token: token)
        try ConnectionStore.save(candidate, accountKey: key)
        connection = candidate
        errorMessage = nil
        // A subscription follows the Apple ID: send it to the account just signed in.
        sentEntitlements = false
        await uploadPushToken()
        await refresh()
    }

    func signOut() async throws {
        guard let api else { return }
        // The push token goes away with the phone's record on the server.
        do {
            try await api.signOut()
        } catch APIError.unauthorized {
            // The phone is already gone on the server, so sign out locally too.
        }
        forget()
    }

    func deleteAccount() async throws {
        guard let api else { return }
        do {
            try await api.deleteAccount()
        } catch APIError.unauthorized {
            // The account is already gone on the server, so sign out locally too.
        }
        try? FileManager.default.removeItem(at: URL.applicationSupportDirectory.appending(path: "chats", directoryHint: .isDirectory))
        forget()
    }

    /// The sign-in screen shows after this.
    private func forget() {
        if let url = connection?.baseURL { ConnectionStore.remove(for: url) }
        connection = nil
        bots = []
        calls = []
        status = nil
        errorMessage = nil
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
            if let live = self.status?.live, live.billing {
                await purchases.loadProducts(ids: live.products?.map(\.id) ?? [])
                if !sentEntitlements {
                    sentEntitlements = true
                    await purchases.sendEntitlements()
                }
            }
        } catch is CancellationError {
            return
        } catch let error as URLError where error.code == .cancelled {
            return
        } catch APIError.unauthorized {
            // The account or phone was removed, for example on the website.
            forget()
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    func calls(for bot: Bot) -> [CallRecord] {
        calls.filter { $0.botId == bot.id }
    }

    /// While the app is open, calls arrive even without push.
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
        } catch APIError.unauthorized {
            forget()
        } catch {
            errorMessage = error.localizedDescription
        }
    }
}

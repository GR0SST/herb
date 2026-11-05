import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase

    var body: some View {
        TabView {
            AgentsView()
                .tabItem { Label("Agents", systemImage: "bubble.left.and.bubble.right") }
            CallsView(bot: nil)
                .tabItem { Label("Calls", systemImage: "phone") }
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
        }
        .fullScreenCover(item: Binding(
            get: { model.callCenter.active },
            set: { _ in }
        )) { _ in
            ActiveCallView()
        }
        .task(id: PollKey(active: scenePhase == .active, connected: model.connection != nil)) {
            guard scenePhase == .active else { return }
            guard model.connection != nil else {
                await model.ensureAccount()
                return
            }
            await model.refresh()
            await model.pollWhileActive()
        }
    }

    private struct PollKey: Equatable {
        let active: Bool
        let connected: Bool
    }
}

struct AgentsView: View {
    @Environment(AppModel.self) private var model
    @State private var addingAgent = false
    @State private var pendingDelete: Bot?

    var body: some View {
        NavigationStack {
            List {
                if let error = model.errorMessage {
                    Label(error, systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.secondary)
                }
                ForEach(model.bots) { bot in
                    NavigationLink(value: bot) { AgentRow(bot: bot) }
                        .swipeActions {
                            Button("Remove", role: .destructive) { pendingDelete = bot }
                        }
                }
            }
            .overlay {
                if model.bots.isEmpty && model.errorMessage == nil {
                    if model.connection == nil {
                        ProgressView()
                    } else {
                        ContentUnavailableView {
                            Label("No Agents", systemImage: "person.crop.circle.badge.plus")
                        } actions: {
                            Button("Connect Agent") { addingAgent = true }
                                .buttonStyle(.borderedProminent)
                        }
                    }
                }
            }
            .navigationTitle("Agents")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Connect Agent", systemImage: "plus") { addingAgent = true }
                        .disabled(model.connection == nil)
                }
            }
            .navigationDestination(for: Bot.self) { bot in
                if bot.capabilities.chat, let api = model.api {
                    ChatView(bot: bot, api: api)
                } else {
                    CallsView(bot: bot)
                }
            }
            .refreshable {
                await model.ensureAccount()
                await model.refresh()
            }
            .sheet(isPresented: $addingAgent) { ConnectAgentView() }
            .confirmationDialog(
                "Remove \(pendingDelete?.name ?? "agent")?",
                isPresented: Binding(get: { pendingDelete != nil }, set: { if !$0 { pendingDelete = nil } }),
                titleVisibility: .visible
            ) {
                Button("Remove", role: .destructive) {
                    if let bot = pendingDelete {
                        Task { await model.deleteAgent(bot) }
                    }
                }
            } message: {
                Text("It will no longer be able to call you. Its call history is deleted.")
            }
        }
    }
}

struct AgentRow: View {
    let bot: Bot

    var body: some View {
        HStack(spacing: 12) {
            Text(bot.name.prefix(1).uppercased())
                .font(.headline)
                .foregroundStyle(.white)
                .frame(width: 40, height: 40)
                .background(Color.accentColor, in: Circle())
                .accessibilityHidden(true)
            Text(bot.name).font(.body.weight(.medium))
        }
        .padding(.vertical, 2)
    }
}

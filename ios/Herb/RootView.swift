import AVFoundation
import SwiftUI

struct RootView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.scenePhase) private var scenePhase
    // Debug builds can open on a tab for App Store screenshots: -HerbDemoTab 1
    @State private var tab = UserDefaults.standard.integer(forKey: "HerbDemoTab")

    var body: some View {
        Group {
            if model.connection == nil {
                WelcomeView()
            } else {
                signedIn
            }
        }
        .fullScreenCover(item: Binding(
            get: { model.callCenter.active },
            set: { _ in }
        )) { _ in
            ActiveCallView()
        }
        .task {
            // Ask up front: there is no way to answer on the lock screen during a call.
            if AVAudioApplication.shared.recordPermission == .undetermined {
                _ = await AVAudioApplication.requestRecordPermission()
            }
        }
        .task(id: PollKey(active: scenePhase == .active, connected: model.connection != nil)) {
            guard scenePhase == .active, model.connection != nil else { return }
            await model.refresh()
            await model.pollWhileActive()
        }
    }

    private var signedIn: some View {
        TabView(selection: $tab) {
            AgentsView()
                .tabItem { Label("Agents", systemImage: "bubble.left.and.bubble.right") }
                .tag(0)
            CallsView(bot: nil)
                .tabItem { Label("Calls", systemImage: "phone") }
                .tag(1)
            SettingsView()
                .tabItem { Label("Settings", systemImage: "gearshape") }
                .tag(2)
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
                    ContentUnavailableView {
                        Label("No Agents", systemImage: "person.crop.circle.badge.plus")
                    } actions: {
                        Button("Connect Agent") { addingAgent = true }
                            .buttonStyle(.borderedProminent)
                            .foregroundStyle(Color(.systemBackground))
                    }
                }
            }
            .navigationTitle("Agents")
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Connect Agent", systemImage: "plus") { addingAgent = true }
                }
            }
            .navigationDestination(for: Bot.self) { bot in
                Group {
                    if bot.capabilities.chat, let api = model.api {
                        ChatView(bot: bot, api: api)
                    } else {
                        CallsView(bot: bot)
                    }
                }
                .toolbar { AgentToolbar(bot: bot) }
            }
            .refreshable { await model.refresh() }
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
    @Environment(AppModel.self) private var model
    let bot: Bot

    var body: some View {
        HStack(spacing: 12) {
            AgentAvatar(name: bot.name, size: 44)
            Text(bot.name).font(.body.weight(.medium))
            Spacer(minLength: 8)
            if model.status?.live?.available == true {
                CallAgentButton(bot: bot, size: 36)
            }
        }
        .padding(.vertical, 2)
    }
}

/// Round phone button that starts a live call with the agent.
/// Grey when nothing receives the agent's call events yet: then it opens the agent's webhook settings.
struct CallAgentButton: View {
    @Environment(AppModel.self) private var model
    let bot: Bot
    var size: CGFloat = 36
    @State private var editing = false

    var body: some View {
        Button {
            if bot.canTakeCalls { model.callCenter.callAgent(bot) } else { editing = true }
        } label: {
            Image(systemName: "phone.fill")
                .font(.system(size: size * 0.42, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: size, height: size)
                .background(bot.canTakeCalls ? Color.green : Color.gray, in: Circle())
        }
        .buttonStyle(.borderless)
        .disabled(model.callCenter.active != nil)
        .accessibilityLabel(bot.canTakeCalls ? "Call \(bot.name)" : "Set up calls with \(bot.name)")
        .sheet(isPresented: $editing) { AgentSettingsView(bot: bot) }
    }
}

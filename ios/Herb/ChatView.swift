import SwiftUI

struct ChatView: View {
    let bot: Bot
    @State private var store: ChatStore
    @State private var draft = ""
    @State private var confirmClear = false
    @FocusState private var inputFocused: Bool

    init(bot: Bot, api: API) {
        self.bot = bot
        _store = State(initialValue: ChatStore(bot: bot, api: api))
    }

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                LazyVStack(spacing: 10) {
                    ForEach(store.messages) { MessageBubble(message: $0) }
                    if store.isStreaming, store.messages.last?.role == .user {
                        ProgressView()
                            .frame(maxWidth: .infinity, alignment: .leading)
                            .accessibilityLabel("\(bot.name) is typing")
                    }
                    if let error = store.errorMessage {
                        VStack(spacing: 8) {
                            Text(error).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                            Button("Try Again") { store.retry() }.font(.footnote.weight(.medium))
                        }
                        .frame(maxWidth: .infinity)
                    }
                    Color.clear.frame(height: 1).id("bottom")
                }
                .padding()
            }
            .scrollDismissesKeyboard(.interactively)
            .overlay {
                if store.messages.isEmpty && !store.isStreaming {
                    AgentContactCard(bot: bot)
                }
            }
            .onChange(of: store.messages.last?.content) { proxy.scrollTo("bottom", anchor: .bottom) }
            .onChange(of: store.isStreaming) { proxy.scrollTo("bottom", anchor: .bottom) }
            .onAppear { proxy.scrollTo("bottom", anchor: .bottom) }
        }
        .safeAreaInset(edge: .bottom) { inputBar }
        .navigationTitle(bot.name)
        .navigationBarTitleDisplayMode(.inline)
        .toolbar {
            ToolbarItem(placement: .topBarTrailing) {
                Menu {
                    NavigationLink { CallsView(bot: bot) } label: { Label("Calls", systemImage: "phone") }
                    Button("Clear Chat", systemImage: "trash", role: .destructive) { confirmClear = true }
                        .disabled(store.messages.isEmpty)
                } label: {
                    Label("More", systemImage: "ellipsis.circle")
                }
            }
        }
        .confirmationDialog("Clear this chat?", isPresented: $confirmClear, titleVisibility: .visible) {
            Button("Clear Chat", role: .destructive) { store.clear() }
        }
    }

    private var inputBar: some View {
        HStack(alignment: .bottom, spacing: 8) {
            TextField("Message", text: $draft, axis: .vertical)
                .lineLimit(1...6)
                .focused($inputFocused)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .background(Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 20))
            if store.isStreaming {
                Button { store.stop() } label: {
                    Image(systemName: "stop.circle.fill").font(.system(size: 34))
                }
                .accessibilityLabel("Stop")
            } else {
                Button {
                    store.send(draft)
                    draft = ""
                } label: {
                    Image(systemName: "arrow.up.circle.fill").font(.system(size: 34))
                }
                .disabled(draft.trimmingCharacters(in: .whitespacesAndNewlines).isEmpty)
                .accessibilityLabel("Send")
            }
        }
        .padding(.horizontal, 12)
        .padding(.vertical, 8)
        .background(.bar)
    }
}

private struct MessageBubble: View {
    let message: ChatMessage
    private var isUser: Bool { message.role == .user }

    var body: some View {
        HStack {
            if isUser { Spacer(minLength: 48) }
            Text(message.content)
                .textSelection(.enabled)
                .padding(.horizontal, 14)
                .padding(.vertical, 9)
                .foregroundStyle(isUser ? Color(.systemBackground) : Color.primary)
                .background(isUser ? Color.accentColor : Color(.secondarySystemBackground), in: RoundedRectangle(cornerRadius: 18))
            if !isUser { Spacer(minLength: 48) }
        }
    }
}

import AVFoundation
import SwiftUI

/// What Herb does, shown on first launch and again from Settings.
struct OnboardingView: View {
    static let doneKey = "herb.onboarded"

    /// From Settings: nothing to ask for, and the last button just closes.
    var replay = false
    let onFinish: () -> Void
    @State private var page = 0

    private let pages = Page.all

    var body: some View {
        VStack(spacing: 0) {
            HStack {
                Spacer()
                Button(replay ? "Close" : "Skip") { onFinish() }
                    .padding(.horizontal, 20)
                    .padding(.vertical, 12)
            }
            TabView(selection: $page) {
                ForEach(pages.indices, id: \.self) { index in
                    PageView(page: pages[index]).tag(index)
                }
            }
            .tabViewStyle(.page(indexDisplayMode: .always))
            .indexViewStyle(.page(backgroundDisplayMode: .always))
            Button {
                if page < pages.count - 1 {
                    withAnimation { page += 1 }
                } else {
                    finish()
                }
            } label: {
                Text(page < pages.count - 1 ? "Continue" : (replay ? "Done" : "Get Started"))
                    .font(.headline)
                    .frame(maxWidth: 240)
            }
            .buttonStyle(.borderedProminent)
            // The accent is black or white, so the label takes the opposite colour.
            .foregroundStyle(Color(.systemBackground))
            .controlSize(.large)
            .padding(.vertical, 16)
        }
    }

    private func finish() {
        guard !replay else { return onFinish() }
        // Asked here, with the reason on screen: there is no way to allow it on the lock screen during a call.
        Task {
            if AVAudioApplication.shared.recordPermission == .undetermined {
                _ = await AVAudioApplication.requestRecordPermission()
            }
            onFinish()
        }
    }

    private struct Page {
        enum Art { case call, agents, talk, ready }
        let art: Art
        let title: String
        let text: String

        static let all = [
            Page(
                art: .call,
                title: "Your AI agent can call you",
                text: "When a long task finishes, something breaks or your agent needs a decision, your iPhone rings like a real call and reads the message aloud."
            ),
            Page(
                art: .agents,
                title: "Works with your agents",
                text: "Add one address to ChatGPT, Claude, Grok, Codex, Claude Code or any MCP app. Then ask the agent to call you when it matters."
            ),
            Page(
                art: .talk,
                title: "Talk it through",
                text: "Answer and talk with your agent in a live call, and interrupt it like a person. Message calls are free. Live calls use minutes from a plan."
            ),
            Page(
                art: .ready,
                title: "Let calls reach you",
                text: "Herb needs the microphone only for live calls. Calls follow your Focus and silent mode settings, so allow Herb in Focus if you want urgent calls to get through."
            ),
        ]
    }

    private struct PageView: View {
        let page: Page

        var body: some View {
            VStack(spacing: 28) {
                Spacer(minLength: 0)
                art.frame(height: 280)
                VStack(spacing: 12) {
                    Text(page.title)
                        .font(.title.bold())
                        .multilineTextAlignment(.center)
                    Text(page.text)
                        .font(.body)
                        .foregroundStyle(.secondary)
                        .multilineTextAlignment(.center)
                }
                .padding(.horizontal, 32)
                Spacer(minLength: 48)
            }
        }

        @ViewBuilder
        private var art: some View {
            switch page.art {
            case .call: IncomingCallMock()
            case .agents: AgentLogos()
            case .talk: Symbol(name: "waveform", secondary: "phone.fill")
            case .ready: Symbol(name: "mic.fill", secondary: "bell.badge.fill")
            }
        }
    }
}

/// A lock screen call, like the one an agent makes.
private struct IncomingCallMock: View {
    var body: some View {
        VStack(spacing: 14) {
            Text("Incoming call").font(.caption).foregroundStyle(.white.opacity(0.7))
            AgentAvatar(name: "Codex", size: 56)
            Text("Codex").font(.title2.weight(.semibold)).foregroundStyle(.white)
            Text("The payments API has been failing for five minutes.")
                .font(.footnote)
                .foregroundStyle(.white.opacity(0.85))
                .multilineTextAlignment(.center)
                .padding(.horizontal, 12)
            HStack(spacing: 56) {
                callButton(color: .red, symbol: "phone.down.fill")
                callButton(color: .green, symbol: "phone.fill")
            }
            .padding(.top, 6)
        }
        .padding(24)
        .frame(width: 260)
        .background(
            LinearGradient(colors: [Color(white: 0.18), Color(white: 0.05)], startPoint: .top, endPoint: .bottom),
            in: RoundedRectangle(cornerRadius: 32, style: .continuous)
        )
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("An incoming call from Codex")
    }

    private func callButton(color: Color, symbol: String) -> some View {
        Image(systemName: symbol)
            .font(.title3)
            .foregroundStyle(.white)
            .frame(width: 52, height: 52)
            .background(color, in: Circle())
    }
}

private struct AgentLogos: View {
    private let names = ["ChatGPT", "Claude", "Grok Bot", "Codex", "Claude Code", "Cursor"]

    var body: some View {
        LazyVGrid(columns: Array(repeating: GridItem(.fixed(76), spacing: 20), count: 3), spacing: 20) {
            ForEach(names, id: \.self) { name in
                AgentAvatar(name: name, size: 72)
            }
        }
        .accessibilityElement(children: .ignore)
        .accessibilityLabel("ChatGPT, Claude, Grok, Codex, Claude Code, Cursor and more")
    }
}

private struct Symbol: View {
    let name: String
    let secondary: String

    var body: some View {
        ZStack(alignment: .bottomTrailing) {
            Image(systemName: name)
                .font(.system(size: 72, weight: .semibold))
                .foregroundStyle(Color.accentColor)
                .frame(width: 180, height: 180)
                .background(Color.accentColor.opacity(0.12), in: Circle())
            Image(systemName: secondary)
                .font(.system(size: 26, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 60, height: 60)
                .background(Color.green, in: Circle())
                .overlay(Circle().strokeBorder(Color(.systemBackground), lineWidth: 4))
        }
        .accessibilityHidden(true)
    }
}

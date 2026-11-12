import SwiftUI

/// Call history for all agents or one. Also the main screen of an agent without chat.
struct CallsView: View {
    @Environment(AppModel.self) private var model
    let bot: Bot?

    private var records: [CallRecord] {
        bot.map(model.calls(for:)) ?? model.calls
    }

    var body: some View {
        if bot == nil {
            NavigationStack { list }
        } else {
            list
        }
    }

    private var list: some View {
        List {
            if let bot {
                Section { AgentContactCard(bot: bot) }
                    .listRowBackground(Color.clear)
            }
            ForEach(records) { CallRow(record: $0, showAgent: bot == nil) }
        }
        .overlay {
            if records.isEmpty && bot == nil {
                ContentUnavailableView("No Calls", systemImage: "phone")
            }
        }
            .navigationTitle(bot?.name ?? "Calls")
            .refreshable { await model.refresh() }
    }
}

struct CallRow: View {
    let record: CallRecord
    let showAgent: Bool

    private var icon: (name: String, color: Color) {
        let arrow = record.outgoing == true ? "phone.arrow.up.right" : "phone.arrow.down.left"
        switch record.status {
        case .played, .answered, .ended: return (arrow, .green)
        case .ringing: return ("phone.badge.waveform", .accentColor)
        case .declined: return ("phone.down", .secondary)
        case .missed, .failed: return (arrow, .red)
        }
    }

    var body: some View {
        HStack(alignment: .top, spacing: 12) {
            Image(systemName: icon.name)
                .foregroundStyle(icon.color)
                .frame(width: 24)
                .accessibilityHidden(true)
            VStack(alignment: .leading, spacing: 3) {
                Text(record.title ?? (showAgent ? record.botName : record.status.label))
                    .font(.body.weight(.medium))
                if let text = record.text {
                    Text(text.withoutStressMarks).font(.subheadline).foregroundStyle(.secondary).lineLimit(4)
                } else if record.hasAudio {
                    Text("Voice message").font(.subheadline).foregroundStyle(.secondary)
                }
                Text(subtitle).font(.caption).foregroundStyle(.secondary)
            }
        }
        .accessibilityElement(children: .combine)
    }

    private var subtitle: String {
        let time = record.date.formatted(date: .abbreviated, time: .shortened)
        return showAgent ? "\(record.botName) · \(record.status.label) · \(time)" : "\(record.status.label) · \(time)"
    }
}

/// Current call screen, shown over the app.
struct ActiveCallView: View {
    @Environment(AppModel.self) private var model

    var body: some View {
        if let session = model.callCenter.active {
            content(session)
        }
    }

    private func content(_ session: CallSession) -> some View {
        VStack(spacing: 16) {
            Spacer()
            AgentAvatar(name: session.botName, size: 112)
            Text(session.botName).font(.largeTitle.weight(.semibold))
            if let connected = session.connectedAt, session.phase == .live || session.phase == .playing {
                // Time on the line, like the Phone app.
                TimelineView(.periodic(from: connected, by: 1)) { context in
                    Text(Self.duration(context.date.timeIntervalSince(connected)))
                        .font(.title3.monospacedDigit())
                        .foregroundStyle(.secondary)
                }
            } else {
                Text(phaseLabel(session)).font(.title3).foregroundStyle(.secondary)
            }
            if let title = session.title {
                Text(title).font(.headline).multilineTextAlignment(.center)
            }
            if session.live {
                LiveTranscript(lines: session.lines)
            } else if let text = session.text {
                ScrollView {
                    Text(text.withoutStressMarks)
                        .font(.body)
                        .frame(maxWidth: .infinity, alignment: .leading)
                }
                .frame(maxHeight: 240)
            }
            Spacer()
            buttons(session)
        }
        .padding(24)
        .frame(maxWidth: .infinity, maxHeight: .infinity)
        .background(Color(.systemBackground))
    }

    static func duration(_ seconds: TimeInterval) -> String {
        let total = max(0, Int(seconds))
        let hours = total / 3600, minutes = total % 3600 / 60, rest = total % 60
        return hours > 0 ? String(format: "%d:%02d:%02d", hours, minutes, rest) : String(format: "%02d:%02d", minutes, rest)
    }

    private func phaseLabel(_ session: CallSession) -> String {
        switch session.phase {
        case .ringing: "Calling…"
        case .connecting: session.live ? "Calling…" : "Connecting…"
        case .playing: "Speaking"
        case .live: "Live"
        case .waiting(let note): note
        case .ended(let note): note
        }
    }

    @ViewBuilder
    private func buttons(_ session: CallSession) -> some View {
        switch session.phase {
        case .ringing:
            HStack(spacing: 64) {
                CallButton(title: "Decline", systemImage: "phone.down.fill", color: .red) {
                    model.callCenter.end(session.id)
                }
                CallButton(title: "Answer", systemImage: "phone.fill", color: .green) {
                    model.callCenter.answer(session.id)
                }
            }
        case .connecting, .live:
            if session.live {
                HStack(spacing: 64) {
                    CallButton(
                        title: session.muted ? "Unmute" : "Mute",
                        systemImage: session.muted ? "mic.slash.fill" : "mic.fill",
                        color: session.muted ? .orange : .gray
                    ) {
                        model.callCenter.setMuted(session.id, !session.muted)
                    }
                    CallButton(title: "End", systemImage: "phone.down.fill", color: .red) {
                        model.callCenter.end(session.id)
                    }
                }
            } else {
                CallButton(title: "End", systemImage: "phone.down.fill", color: .red) {
                    model.callCenter.end(session.id)
                }
            }
        case .playing, .waiting:
            CallButton(title: "End", systemImage: "phone.down.fill", color: .red) {
                model.callCenter.end(session.id)
            }
        case .ended:
            EmptyView()
        }
    }
}

/// What was said in a live call, newest at the bottom.
private struct LiveTranscript: View {
    let lines: [CallSession.Line]

    var body: some View {
        ScrollViewReader { proxy in
            ScrollView {
                VStack(alignment: .leading, spacing: 10) {
                    ForEach(lines) { line in
                        Text(line.text.withoutStressMarks)
                            .font(.body)
                            .foregroundStyle(line.speaker == .user ? .secondary : .primary)
                            .frame(maxWidth: .infinity, alignment: line.speaker == .user ? .trailing : .leading)
                            .multilineTextAlignment(line.speaker == .user ? .trailing : .leading)
                            .id(line.id)
                    }
                }
            }
            .frame(maxHeight: 280)
            .onChange(of: lines.last?.text) {
                if let last = lines.last { proxy.scrollTo(last.id, anchor: .bottom) }
            }
        }
    }
}

private struct CallButton: View {
    let title: String
    let systemImage: String
    let color: Color
    let action: () -> Void

    var body: some View {
        Button(action: action) {
            VStack(spacing: 8) {
                Image(systemName: systemImage)
                    .font(.title)
                    .foregroundStyle(.white)
                    .frame(width: 72, height: 72)
                    .background(color, in: Circle())
                Text(title).font(.subheadline).foregroundStyle(.primary)
            }
        }
        .buttonStyle(.plain)
    }
}

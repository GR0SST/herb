import StoreKit
import AVFoundation
import SwiftUI
import UIKit

struct SettingsView: View {
    @Environment(AppModel.self) private var model
    @State private var confirmDelete = false
    @State private var confirmSignOut = false
    @State private var isWorking = false
    @State private var showKey = false
    @State private var copied = false
    @State private var error: String?
    @AppStorage(CallCenter.autoHangUpKey) private var autoHangUp = true

    var body: some View {
        NavigationStack {
            List {
                if model.pushUnavailable {
                    Label("Calls ring only while Herb is open", systemImage: "exclamationmark.triangle")
                        .foregroundStyle(.secondary)
                }
                if let live = model.status?.live, live.available {
                    LiveCallsSection(live: live)
                }
                VoiceSection()
                Section {
                    Toggle("Auto Hang Up", isOn: $autoHangUp)
                } header: {
                    Text("Calls")
                } footer: {
                    Text("When off, a call stays open after the message until you hang up.")
                }
                Section {
                    LabeledContent("Server", value: model.connection?.baseURL.host() ?? "—")
                    if let key = model.accountKey {
                        Button {
                            if showKey {
                                UIPasteboard.general.string = key
                                copied = true
                            } else {
                                showKey = true
                            }
                        } label: {
                            LabeledContent("Account Key") {
                                if showKey {
                                    Text(copied ? "Copied" : key)
                                        .font(.footnote.monospaced())
                                        .multilineTextAlignment(.trailing)
                                } else {
                                    Text("Show")
                                }
                            }
                        }
                        .foregroundStyle(.primary)
                    }
                    Button("Sign Out") { confirmSignOut = true }
                        .disabled(isWorking)
                    Button("Delete Account", role: .destructive) { confirmDelete = true }
                        .disabled(isWorking)
                    if isWorking {
                        ProgressView().frame(maxWidth: .infinity)
                    }
                    if let error {
                        Text(error).foregroundStyle(.red)
                    }
                } header: {
                    Text("Account")
                } footer: {
                    Text("Your account key signs you in on another phone. Tap it to copy.")
                }
            }
            .navigationTitle("Settings")
            .refreshable { await model.refresh() }
            .confirmationDialog("Sign out on this phone?", isPresented: $confirmSignOut, titleVisibility: .visible) {
                Button("Sign Out") { run { try await model.signOut() } }
            } message: {
                Text("You will need your account key to sign in again.")
            }
            .confirmationDialog("Delete your account?", isPresented: $confirmDelete, titleVisibility: .visible) {
                Button("Delete Account", role: .destructive) { run { try await model.deleteAccount() } }
            } message: {
                Text("Your agents, phones and call history are deleted.")
            }
        }
    }

    private func run(_ action: @escaping () async throws -> Void) {
        isWorking = true
        error = nil
        Task {
            defer { isWorking = false }
            do {
                try await action()
            } catch {
                self.error = error.localizedDescription
            }
        }
    }
}

/// Download, choose and remove the on-device voice.
private struct VoiceSection: View {
    private var voice = VoiceModel.shared
    @AppStorage(SpeechVoice.storageKey) private var selected = SpeechVoice.all[0].id
    @State private var confirmDelete = false
    @State private var preview = VoicePreview()

    var body: some View {
        Section {
            switch voice.state {
            case .missing:
                Button("Download Voice") { voice.download() }
            case .downloading(let progress):
                VStack(alignment: .leading, spacing: 8) {
                    ProgressView(value: progress)
                    HStack {
                        Text("Downloading \(Int(progress * 100))%").foregroundStyle(.secondary)
                        Spacer()
                        Button("Cancel") { voice.cancel() }.buttonStyle(.borderless)
                    }
                    .font(.subheadline)
                }
            case .ready:
                Picker("Voice", selection: $selected) {
                    ForEach(SpeechVoice.all) { option in
                        Text("\(option.name) · \(option.detail)").tag(option.id)
                    }
                }
                .pickerStyle(.menu)
                .onChange(of: selected) { preview.play(SpeechVoice.selected) }
                Button {
                    preview.playing == nil ? preview.play(SpeechVoice.selected) : preview.stop()
                } label: {
                    Label(preview.playing == nil ? "Play Sample" : "Stop", systemImage: preview.playing == nil ? "play.fill" : "stop.fill")
                }
                Button("Delete Voice", role: .destructive) { confirmDelete = true }
            case .failed(let message):
                Text(message).foregroundStyle(.red)
                Button("Try Again") { voice.download() }
            }
        } header: {
            Text("Voice")
        } footer: {
            Text("Messages are read on your iPhone with the voice you choose, \(ByteCountFormatter.string(fromByteCount: VoiceModel.totalBytes, countStyle: .file)). Without it, the iOS voice reads them.")
        }
        .confirmationDialog("Delete the voice?", isPresented: $confirmDelete, titleVisibility: .visible) {
            Button("Delete Voice", role: .destructive) {
                preview.stop()
                voice.delete()
            }
        } message: {
            Text("Messages will be read with the iOS voice until you download it again.")
        }
        .onDisappear { preview.stop() }
    }
}

/// Plays a short sample when a voice is picked.
@MainActor
@Observable
private final class VoicePreview {
    private(set) var playing: String?
    @ObservationIgnored private let player = MessagePlayer()

    func play(_ voice: SpeechVoice) {
        player.stop()
        try? AVAudioSession.sharedInstance().setCategory(.playback, mode: .spokenAudio)
        try? AVAudioSession.sharedInstance().setActive(true)
        let id = UUID()
        let text = "Hi, I'm \(voice.name). This is how your agents will sound."
        playing = voice.id
        player.prepareSpeech(id: id, text: text, language: "en")
        player.speak(id: id, text: text, language: "en", onFirstAudio: {}) { [weak self] _, _ in
            if self?.playing == voice.id { self?.playing = nil }
        }
    }

    func stop() {
        player.stop()
        playing = nil
    }
}

/// The live call plan at a glance, with the way to change it.
private struct LiveCallsSection: View {
    @Environment(AppModel.self) private var model
    let live: RelayStatus.Live
    @State private var showingPlans = false
    @State private var managing = false

    private var purchases: Purchases { model.purchases }
    private var subscription: RelayStatus.Live.Subscription? { live.subscription.flatMap { $0.active ? $0 : nil } }
    private var unlimited: Bool { live.unlimited == true || !live.billing }

    var body: some View {
        Section {
            PlanSummary(live: live, planName: planName, subscription: unlimited ? nil : subscription)
                .listRowInsets(EdgeInsets(top: 16, leading: 16, bottom: 16, trailing: 16))
            if !unlimited {
                Button {
                    showingPlans = true
                } label: {
                    Label(subscription == nil ? "See Plans" : "Change Plan", systemImage: "sparkles")
                }
                if live.subscription != nil {
                    Button { managing = true } label: {
                        Label("Manage Subscription", systemImage: "creditcard")
                    }
                }
                Button { Task { await purchases.restore() } } label: {
                    Label("Restore Purchases", systemImage: "arrow.clockwise")
                }
                .disabled(purchases.isWorking)
                if let error = purchases.errorMessage {
                    Text(error).font(.footnote).foregroundStyle(.red)
                }
            }
        } header: {
            Text("Live Calls")
        } footer: {
            if !unlimited {
                Text("Talk with your agents by voice. Minutes renew each period and do not carry over. Message calls are always free.")
            }
        }
        .sheet(isPresented: $showingPlans) { PlansView() }
        .manageSubscriptionsSheet(isPresented: $managing)
    }

    private var planName: String {
        if unlimited { return "Unlimited" }
        if let sub = subscription {
            let name = purchases.products.first { $0.id == sub.productID }?.displayName ?? "Subscription"
            return sub.sandbox ? "\(name) (Test)" : name
        }
        if (live.bonusSeconds ?? 0) > 0 { return "Free Minutes" }
        return "No Plan"
    }
}

/// Plan name, minutes left and how much of the period is used.
private struct PlanSummary: View {
    let live: RelayStatus.Live
    let planName: String
    let subscription: RelayStatus.Live.Subscription?

    private static func minutes(_ seconds: Int) -> Int { Int((Double(seconds) / 60).rounded(.down)) }

    private var isEmpty: Bool { (live.secondsLeft ?? 1) <= 0 }

    var body: some View {
        VStack(alignment: .leading, spacing: 12) {
            HStack(spacing: 12) {
                Image(systemName: "waveform")
                    .font(.system(size: 18, weight: .semibold))
                    .foregroundStyle(.white)
                    .frame(width: 40, height: 40)
                    .background(
                        LinearGradient(colors: isEmpty ? [.gray, .gray.opacity(0.7)] : [.green, .teal], startPoint: .topLeading, endPoint: .bottomTrailing),
                        in: RoundedRectangle(cornerRadius: 11, style: .continuous)
                    )
                VStack(alignment: .leading, spacing: 1) {
                    Text(planName).font(.headline)
                    if let detail {
                        Text(detail).font(.subheadline).foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 8)
                minutesLeft
            }
            if let sub = subscription, sub.secondsTotal > 0 {
                VStack(alignment: .leading, spacing: 6) {
                    ProgressView(value: min(Double(sub.secondsUsed), Double(sub.secondsTotal)), total: Double(sub.secondsTotal))
                        .tint(.green)
                    Text("\(Self.minutes(sub.secondsUsed)) of \(Self.minutes(sub.secondsTotal)) min used this period")
                        .font(.caption)
                        .foregroundStyle(.secondary)
                }
            }
        }
        .accessibilityElement(children: .combine)
    }

    @ViewBuilder
    private var minutesLeft: some View {
        if let seconds = live.secondsLeft {
            VStack(alignment: .trailing, spacing: 0) {
                Text("\(Self.minutes(seconds))")
                    .font(.title2.weight(.semibold).monospacedDigit())
                    .foregroundStyle(isEmpty ? Color.secondary : Color.primary)
                Text("min left").font(.caption).foregroundStyle(.secondary)
            }
        } else {
            Image(systemName: "infinity")
                .font(.title2.weight(.semibold))
                .accessibilityLabel("Unlimited minutes")
        }
    }

    private var detail: String? {
        if let sub = subscription {
            var parts: [String] = []
            if let date = sub.expires {
                parts.append("\(sub.autoRenew == false ? "Ends" : "Renews") \(date.formatted(.dateTime.month(.abbreviated).day()))")
            }
            if let bonus = live.bonusSeconds, bonus >= 60 {
                parts.append("+\(Self.minutes(bonus)) bonus min")
            }
            return parts.isEmpty ? nil : parts.joined(separator: " · ")
        }
        if live.secondsLeft == nil { return "Calls are not counted" }
        if isEmpty { return "Subscribe to call your agents" }
        return "Gifted minutes that never expire"
    }
}

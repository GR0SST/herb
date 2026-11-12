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
                }
                if let live = model.status?.live, live.available {
                    LiveCallsSection(live: live)
                }
                VoiceSection()
                Section {
                    Toggle("Auto Hang Up", isOn: $autoHangUp)
                } footer: {
                    Text("When off, a call stays open after the message until you hang up.")
                }
                Section {
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

/// The live call plan: minutes left, the subscription and its buttons.
private struct LiveCallsSection: View {
    @Environment(AppModel.self) private var model
    let live: RelayStatus.Live
    @State private var managing = false

    private var purchases: Purchases { model.purchases }

    private static func minutes(_ seconds: Int) -> String {
        "\(Int((Double(seconds) / 60).rounded(.down))) min"
    }

    var body: some View {
        Section {
            LabeledContent("Plan", value: planName)
            LabeledContent("Minutes Left") {
                if let seconds = live.secondsLeft {
                    Text(Self.minutes(seconds))
                } else {
                    Image(systemName: "infinity").accessibilityLabel("Unlimited")
                }
            }
            if let sub = live.subscription, sub.active, live.unlimited != true {
                LabeledContent("Used This Period", value: "\(Self.minutes(sub.secondsUsed)) of \(Self.minutes(sub.secondsTotal))")
                if let date = sub.expires {
                    LabeledContent(sub.autoRenew == false ? "Ends" : "Renews", value: date.formatted(date: .abbreviated, time: .omitted))
                }
            }
            if let bonus = live.bonusSeconds, bonus > 0, live.unlimited != true {
                LabeledContent("Bonus Minutes", value: Self.minutes(bonus))
            }
            if live.billing && live.unlimited != true {
                // All plans stay visible: buying another one in the group is an upgrade or downgrade through Apple.
                ForEach(purchases.products, id: \.id) { product in
                    let current = live.subscription?.active == true && live.subscription?.productID == product.id
                    Button {
                        Task { await purchases.buy(product) }
                    } label: {
                        HStack {
                            VStack(alignment: .leading, spacing: 2) {
                                Text(product.displayName).foregroundStyle(.primary)
                                if let minutes = live.products?.first(where: { $0.id == product.id })?.minutes {
                                    Text("\(minutes) min / \(period(product))").font(.footnote).foregroundStyle(.secondary)
                                }
                            }
                            Spacer()
                            if current {
                                Text("Current").foregroundStyle(.secondary)
                            } else {
                                Text("\(product.displayPrice) / \(period(product))")
                            }
                        }
                    }
                    .disabled(purchases.isWorking || current)
                }
                if live.subscription != nil {
                    Button("Manage Subscription") { managing = true }
                }
                Button("Restore Purchases") { Task { await purchases.restore() } }
                    .disabled(purchases.isWorking)
            }
            if let error = purchases.errorMessage {
                Text(error).foregroundStyle(.red)
            }
        } header: {
            Text("Live Calls")
        } footer: {
            if live.billing && live.unlimited != true {
                VStack(alignment: .leading, spacing: 6) {
                    Text("Minutes renew each period and do not carry over. The subscription renews automatically at the price shown until you cancel it at least 24 hours before the period ends, in Manage Subscription. It belongs to your Apple ID and moves with you to another account key.")
                    if let base = model.connection?.baseURL {
                        HStack(spacing: 16) {
                            Link("Terms of Use", destination: base.appending(path: "terms"))
                            Link("Privacy Policy", destination: base.appending(path: "privacy"))
                        }
                    }
                }
            }
        }
        .manageSubscriptionsSheet(isPresented: $managing)
    }

    private var planName: String {
        if live.unlimited == true { return "Unlimited" }
        if let sub = live.subscription, sub.active {
            let name = purchases.products.first { $0.id == sub.productID }?.displayName ?? "Subscription"
            return sub.sandbox ? "\(name) (Test)" : name
        }
        if (live.bonusSeconds ?? 0) > 0 { return "Free Minutes" }
        return "None"
    }

    private func period(_ product: Product) -> String {
        guard let unit = product.subscription?.subscriptionPeriod.unit else { return "" }
        switch unit {
        case .day: return "day"
        case .week: return "week"
        case .month: return "month"
        case .year: return "year"
        @unknown default: return ""
        }
    }
}

import StoreKit
import SwiftUI

/// Live call plans: shown from Settings and when someone calls an agent without minutes.
struct PlansView: View {
    @Environment(AppModel.self) private var model
    @Environment(\.dismiss) private var dismiss
    @State private var selected: String?
    @State private var managing = false

    private var purchases: Purchases { model.purchases }
    private var live: RelayStatus.Live? { model.status?.live }
    private var current: RelayStatus.Live.Subscription? { live?.subscription.flatMap { $0.active ? $0 : nil } }
    private var choice: Product? { purchases.products.first { $0.id == selected } }

    var body: some View {
        NavigationStack {
            ScrollView {
                VStack(spacing: 28) {
                    header
                    features
                    plans
                }
                .padding(.horizontal, 20)
                .padding(.top, 8)
                .padding(.bottom, 24)
            }
            .safeAreaInset(edge: .bottom) { actions }
            .toolbar {
                ToolbarItem(placement: .topBarTrailing) {
                    Button("Close", systemImage: "xmark") { dismiss() }
                        .labelStyle(.iconOnly)
                }
            }
            .manageSubscriptionsSheet(isPresented: $managing)
        }
        .onAppear(perform: preselect)
        .onChange(of: purchases.products.map(\.id)) { preselect() }
        // Close once the purchase reaches the server.
        .onChange(of: current?.productID) { _, id in
            if let id, id == selected { dismiss() }
        }
    }

    private var header: some View {
        VStack(spacing: 12) {
            Image(systemName: "waveform")
                .font(.system(size: 34, weight: .semibold))
                .foregroundStyle(.white)
                .frame(width: 76, height: 76)
                .background(
                    LinearGradient(colors: [.green, .teal], startPoint: .topLeading, endPoint: .bottomTrailing),
                    in: RoundedRectangle(cornerRadius: 22, style: .continuous)
                )
                .shadow(color: .green.opacity(0.3), radius: 12, y: 6)
            Text("Talk With Your Agents")
                .font(.title.bold())
                .multilineTextAlignment(.center)
            Text(model.needsPlan ? "You are out of live call minutes. Pick a plan to keep talking." : "Call an agent and talk it through, or let it call you when it needs a decision.")
                .font(.body)
                .foregroundStyle(.secondary)
                .multilineTextAlignment(.center)
        }
        .padding(.top, 8)
    }

    private var features: some View {
        VStack(alignment: .leading, spacing: 14) {
            Feature(icon: "phone.fill", title: "Two-way calls", detail: "Speak naturally, interrupt and ask follow-up questions.")
            Feature(icon: "sparkles", title: "Your agent does the work", detail: "The voice passes questions to your agent and tells you its answer.")
            Feature(icon: "arrow.clockwise", title: "Fresh minutes each month", detail: "Cancel any time in your Apple ID settings.")
        }
        .frame(maxWidth: .infinity, alignment: .leading)
    }

    @ViewBuilder
    private var plans: some View {
        if purchases.products.isEmpty {
            VStack(spacing: 12) {
                if let problem = purchases.productsError {
                    Text(problem).font(.footnote).foregroundStyle(.secondary).multilineTextAlignment(.center)
                    Button("Load Plans Again") { Task { await purchases.reloadProducts() } }
                } else {
                    ProgressView()
                }
            }
            .frame(maxWidth: .infinity, minHeight: 120)
        } else {
            VStack(spacing: 10) {
                ForEach(purchases.products, id: \.id) { product in
                    PlanCard(
                        product: product,
                        minutes: minutes(product),
                        isSelected: selected == product.id,
                        isCurrent: current?.productID == product.id,
                        isPopular: isPopular(product)
                    ) { selected = product.id }
                }
            }
        }
    }

    private var actions: some View {
        VStack(spacing: 10) {
            Button {
                guard let choice else { return }
                Task { await purchases.buy(choice) }
            } label: {
                ZStack {
                    if purchases.isWorking {
                        ProgressView().tint(.white)
                    } else {
                        Text(buttonTitle).font(.headline)
                    }
                }
                .foregroundStyle(.white)
                .frame(maxWidth: .infinity, minHeight: 52)
                .background(canBuy ? Color.green : Color.gray.opacity(0.5), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            }
            .buttonStyle(.plain)
            .disabled(!canBuy || purchases.isWorking)

            if let error = purchases.errorMessage {
                Text(error).font(.footnote).foregroundStyle(.red).multilineTextAlignment(.center)
            }

            HStack(spacing: 18) {
                Button("Restore") { Task { await purchases.restore() } }
                if current != nil {
                    Button("Manage") { managing = true }
                }
                if let base = model.connection?.baseURL {
                    Link("Terms", destination: base.appending(path: "terms"))
                    Link("Privacy", destination: base.appending(path: "privacy"))
                }
            }
            .font(.footnote)
            .tint(.secondary)
            .disabled(purchases.isWorking)

            Text("Renews automatically until you cancel at least 24 hours before the period ends. Unused minutes do not carry over. The plan belongs to your Apple ID.")
                .font(.caption2)
                .foregroundStyle(.tertiary)
                .multilineTextAlignment(.center)
        }
        .padding(.horizontal, 20)
        .padding(.top, 12)
        .padding(.bottom, 4)
        .background(.bar)
    }

    private var canBuy: Bool { choice != nil && choice?.id != current?.productID }

    private var buttonTitle: String {
        guard let choice else { return "Choose a Plan" }
        if choice.id == current?.productID { return "Your Current Plan" }
        let price = "\(choice.displayPrice) / \(choice.periodName)"
        return current == nil ? "Subscribe for \(price)" : "Switch for \(price)"
    }

    private func minutes(_ product: Product) -> Int? {
        live?.products?.first { $0.id == product.id }?.minutes
    }

    /// The middle plan when there are three or more.
    private func isPopular(_ product: Product) -> Bool {
        let all = purchases.products
        return all.count >= 3 && all[all.count / 2].id == product.id
    }

    private func preselect() {
        guard selected == nil || !purchases.products.contains(where: { $0.id == selected }) else { return }
        let all = purchases.products
        guard !all.isEmpty else { return }
        if let current, let next = all.first(where: { $0.price > (all.first { $0.id == current.productID }?.price ?? 0) }) {
            selected = next.id
        } else {
            selected = all[all.count >= 3 ? all.count / 2 : 0].id
        }
    }
}

private struct Feature: View {
    let icon: String
    let title: String
    let detail: String

    var body: some View {
        HStack(alignment: .top, spacing: 14) {
            Image(systemName: icon)
                .font(.system(size: 15, weight: .semibold))
                .foregroundStyle(.green)
                .frame(width: 34, height: 34)
                .background(Color.green.opacity(0.14), in: Circle())
            VStack(alignment: .leading, spacing: 2) {
                Text(title).font(.subheadline.weight(.semibold))
                Text(detail).font(.subheadline).foregroundStyle(.secondary)
            }
        }
    }
}

private struct PlanCard: View {
    let product: Product
    let minutes: Int?
    let isSelected: Bool
    let isCurrent: Bool
    let isPopular: Bool
    let select: () -> Void

    var body: some View {
        Button(action: select) {
            HStack(spacing: 14) {
                Image(systemName: isSelected ? "checkmark.circle.fill" : "circle")
                    .font(.title3)
                    .foregroundStyle(isSelected ? Color.green : Color.secondary.opacity(0.5))
                VStack(alignment: .leading, spacing: 3) {
                    HStack(spacing: 6) {
                        Text(product.displayName).font(.headline)
                        if isCurrent {
                            Badge(text: "Current", color: .secondary)
                        } else if isPopular {
                            Badge(text: "Popular", color: .green)
                        }
                    }
                    if let minutes {
                        Text("\(minutes) minutes a \(product.periodName)")
                            .font(.subheadline)
                            .foregroundStyle(.secondary)
                    }
                }
                Spacer(minLength: 8)
                VStack(alignment: .trailing, spacing: 3) {
                    Text(product.displayPrice).font(.headline)
                    if let perMinute {
                        Text("\(perMinute) / min").font(.caption).foregroundStyle(.secondary)
                    }
                }
            }
            .padding(16)
            .background(Color(.secondarySystemGroupedBackground), in: RoundedRectangle(cornerRadius: 16, style: .continuous))
            .overlay {
                RoundedRectangle(cornerRadius: 16, style: .continuous)
                    .strokeBorder(isSelected ? Color.green : Color(.separator).opacity(0.6), lineWidth: isSelected ? 2 : 1)
            }
            .contentShape(RoundedRectangle(cornerRadius: 16, style: .continuous))
        }
        .buttonStyle(.plain)
        .accessibilityAddTraits(isSelected ? .isSelected : [])
    }

    private var perMinute: String? {
        guard let minutes, minutes > 0 else { return nil }
        return (product.price / Decimal(minutes)).formatted(product.priceFormatStyle.precision(.fractionLength(2)))
    }
}

private struct Badge: View {
    let text: String
    let color: Color

    var body: some View {
        Text(text.uppercased())
            .font(.caption2.weight(.bold))
            .foregroundStyle(color)
            .padding(.horizontal, 6)
            .padding(.vertical, 2)
            .background(color.opacity(0.14), in: Capsule())
    }
}

extension Product {
    /// "month" for a monthly plan.
    var periodName: String {
        switch subscription?.subscriptionPeriod.unit {
        case .day: "day"
        case .week: "week"
        case .month: "month"
        case .year: "year"
        default: "period"
        }
    }
}

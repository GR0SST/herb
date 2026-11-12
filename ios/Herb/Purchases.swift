import Foundation
import Observation
import StoreKit

/// Live call subscriptions through the App Store.
/// The server decides the minutes: the app only passes signed transactions on. A subscription belongs
/// to the Apple ID, so sending it from another account moves it there.
@MainActor
@Observable
final class Purchases {
    private(set) var products: [Product] = []
    private(set) var isWorking = false
    var errorMessage: String?

    @ObservationIgnored var api: () -> API? = { nil }
    @ObservationIgnored var onChange: () -> Void = {}
    @ObservationIgnored private var updates: Task<Void, Never>?

    /// Renewals and purchases made elsewhere arrive here, even while the app is closed.
    func start() {
        guard updates == nil else { return }
        updates = Task { [weak self] in
            for await result in Transaction.updates {
                await self?.handle(result)
            }
        }
    }

    func loadProducts(ids: [String]) async {
        guard !ids.isEmpty, Set(ids) != Set(products.map(\.id)) else { return }
        do {
            products = try await Product.products(for: ids).sorted { $0.price < $1.price }
        } catch {
            products = []
        }
    }

    func buy(_ product: Product) async {
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            switch try await product.purchase() {
            case .success(let result):
                await handle(result)
            case .pending, .userCancelled:
                break
            @unknown default:
                break
            }
        } catch {
            errorMessage = error.localizedDescription
        }
    }

    /// Restore Purchases: asks the App Store for the latest state, then sends it.
    func restore() async {
        isWorking = true
        errorMessage = nil
        defer { isWorking = false }
        do {
            try await AppStore.sync()
        } catch StoreKitError.userCancelled {
            return
        } catch {
            errorMessage = error.localizedDescription
            return
        }
        await sendEntitlements()
    }

    /// Sends the subscriptions this Apple ID has, after sign-in and on launch.
    func sendEntitlements() async {
        for await result in Transaction.currentEntitlements {
            guard case .verified(let transaction) = result, transaction.productType == .autoRenewable else { continue }
            await send(result.jwsRepresentation)
        }
        onChange()
    }

    private func handle(_ result: VerificationResult<Transaction>) async {
        guard case .verified(let transaction) = result else { return }
        if await send(result.jwsRepresentation) {
            await transaction.finish()
        }
        onChange()
    }

    /// The server checks Apple's signature itself. Returns false if it could not take the transaction.
    @discardableResult
    private func send(_ jws: String) async -> Bool {
        guard let api = api() else { return false }
        do {
            try await api.sendTransaction(jws)
            return true
        } catch {
            errorMessage = error.localizedDescription
            return false
        }
    }
}

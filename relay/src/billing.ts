import { type AppleNotification, type AppleRenewalInfo, type AppleTransaction, AppleSignatureError, verifyAppleJws } from "./apple";
import type { Store, Subscription } from "./db";

/**
 * Live call minutes: who may talk and for how long.
 *
 * - Unlimited accounts, such as the server owner and friends, are never counted.
 * - A subscription gives a number of minutes per period. Unused minutes do not carry over.
 * - Bonus minutes, gifted or free for new accounts, never expire and are spent after the subscription's.
 * Without billing everyone is unlimited, as on a self-hosted server.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

export interface BillingOptions {
  store: Store;
  now: () => number;
  enabled: boolean;
  /** App Store product id → minutes per period. */
  products: Record<string, number>;
  /** The app's bundle id. Transactions for other apps are refused. */
  bundleId: string | null;
  /** Sandbox purchases (TestFlight, App Review) are free, so they give at most this many minutes. */
  sandboxMinutes: number;
  /** Trusted roots, for tests. Defaults to Apple Root CA - G3. */
  roots?: string[];
  checkMarkers?: boolean;
}

export class BillingError extends Error {
  constructor(readonly code: string, message: string, readonly status = 400) {
    super(message);
  }
}

export function createBilling(options: BillingOptions) {
  const { store, now } = options;

  const verify = <T>(jws: string) => {
    try {
      return verifyAppleJws<T>(jws, { roots: options.roots, checkMarkers: options.checkMarkers, now: new Date(now()) });
    } catch (error) {
      if (error instanceof AppleSignatureError) throw new BillingError("invalid_signature", `App Store data is not valid: ${error.message}`);
      throw new BillingError("invalid_signature", "App Store data is not valid");
    }
  };

  const unlimited = (accountId: string) => !options.enabled || store.isUnlimited(accountId);
  const left = (sub: Subscription | null) => (sub ? Math.max(0, sub.seconds_total - sub.seconds_used) : 0);

  /** What the app shows in Settings. */
  function plan(accountId: string) {
    const active = store.activeSubscription(accountId, now());
    const latest = active ?? store.latestSubscription(accountId);
    const bonus = store.liveSeconds(accountId);
    const isUnlimited = unlimited(accountId);
    return {
      billing: options.enabled,
      unlimited: isUnlimited,
      seconds_left: isUnlimited ? null : left(active) + bonus,
      bonus_seconds: bonus,
      subscription: latest
        ? {
          product_id: latest.product_id,
          active: Boolean(active),
          seconds_total: latest.seconds_total,
          seconds_used: latest.seconds_used,
          period_start: latest.period_start,
          expires_at: latest.expires_at,
          auto_renew: latest.auto_renew === null ? null : latest.auto_renew === 1,
          sandbox: latest.environment !== "Production",
        }
        : null,
      products: Object.entries(options.products).map(([id, minutes]) => ({ id, minutes })),
    };
  }

  /** Seconds the account may talk now, or null for no limit. */
  function budget(accountId: string) {
    if (unlimited(accountId)) return null;
    return left(store.activeSubscription(accountId, now())) + store.liveSeconds(accountId);
  }

  function spend(accountId: string, seconds: number) {
    if (unlimited(accountId) || seconds <= 0) return;
    const sub = store.activeSubscription(accountId, now());
    const fromSub = Math.min(seconds, left(sub));
    if (sub && fromSub > 0) store.spendSubscription(sub.original_transaction_id, fromSub);
    if (seconds > fromSub) store.addLiveSeconds(accountId, -(seconds - fromSub));
  }

  /** Records a transaction. accountId is the account that sent it from the phone; null for Apple's notifications. */
  function apply(tx: AppleTransaction, accountId: string | null, autoRenew?: boolean) {
    if (options.bundleId && tx.bundleId !== options.bundleId) throw new BillingError("wrong_app", "This purchase is for another app");
    const minutes = options.products[tx.productId];
    if (minutes === undefined) throw new BillingError("unknown_product", "Unknown product");
    const sandbox = tx.environment !== "Production";
    const seconds = Math.round((sandbox ? Math.min(minutes, options.sandboxMinutes) : minutes) * 60);
    const existing = store.subscription(tx.originalTransactionId);

    let owner = existing?.account_id ?? null;
    let movedAt = existing?.moved_at ?? null;
    if (accountId && owner !== accountId) {
      // The subscription follows the Apple ID: signing in with another key moves it, at most once a day.
      if (owner && movedAt && now() - movedAt < DAY_MS) {
        throw new BillingError("moved_recently", "This subscription moved to another account less than a day ago", 409);
      }
      if (owner) movedAt = now();
      owner = accountId;
    }

    // A transaction newer than the one that started the current period starts the next one.
    const newPeriod = !existing || (tx.transactionId !== existing.transaction_id && tx.purchaseDate > existing.period_start);
    const current = existing && !newPeriod ? existing : null;
    const sub: Subscription = {
      original_transaction_id: tx.originalTransactionId,
      account_id: owner,
      product_id: tx.productId,
      environment: tx.environment,
      transaction_id: current ? current.transaction_id : tx.transactionId,
      period_start: current ? current.period_start : tx.purchaseDate,
      expires_at: current && tx.transactionId !== current.transaction_id ? current.expires_at : tx.expiresDate ?? null,
      seconds_total: current ? current.seconds_total : seconds,
      seconds_used: current ? current.seconds_used : 0,
      auto_renew: autoRenew === undefined ? existing?.auto_renew ?? null : autoRenew ? 1 : 0,
      revoked: tx.revocationDate && (!current || tx.transactionId === current.transaction_id) ? 1 : current?.revoked ?? 0,
      moved_at: movedAt,
      updated_at: now(),
    };
    store.saveSubscription(sub);
    return sub;
  }

  /** The phone sends a signed transaction after a purchase, on launch and when restoring. */
  function fromPhone(accountId: string, jws: string) {
    if (!options.enabled) throw new BillingError("billing_off", "Purchases are not used on this server", 409);
    apply(verify<AppleTransaction>(jws), accountId);
    return plan(accountId);
  }

  /** App Store Server Notifications V2: renewals, expirations, refunds. */
  function fromApple(signedPayload: string) {
    const notification = verify<AppleNotification>(signedPayload);
    const data = notification.data;
    if (!data?.signedTransactionInfo) return { handled: false, type: notification.notificationType };
    const tx = verify<AppleTransaction>(data.signedTransactionInfo);
    const renewal = data.signedRenewalInfo ? verify<AppleRenewalInfo>(data.signedRenewalInfo) : null;
    apply(tx, null, renewal?.autoRenewStatus === undefined ? undefined : renewal.autoRenewStatus === 1);
    return { handled: true, type: notification.notificationType };
  }

  function canStart(accountId: string) {
    const seconds = budget(accountId);
    return seconds === null || seconds > 0;
  }

  return { plan, budget, spend, canStart, fromPhone, fromApple, apply };
}

export type Billing = ReturnType<typeof createBilling>;

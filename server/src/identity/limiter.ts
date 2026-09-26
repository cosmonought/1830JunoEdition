// server/src/identity/limiter.ts
//
// LIVE-2B (LIVE-2 §12.2): the identity limiters of one server, built from `IngressLimits.identity`. In memory,
// keyed by IP key, session id or "global", pruned by the 60-second sweep. Every refusal is counted by name in
// `denied` (LIVE-2 §12.1's `limits.denied{bucket}`).

import { IpBuckets, KeyedBuckets, MalformedCooldowns, type IdentityLimits } from "../ingress/limits";

export type DeniedCounters = Record<string, number>;

export class IdentityLimiter {
  readonly failedUpgrades: IpBuckets;
  readonly upgrades: IpBuckets;
  readonly upgradesGlobal: KeyedBuckets;
  readonly guestCreates: IpBuckets;
  readonly guestCreatesGlobal: KeyedBuckets;
  readonly bootstraps: KeyedBuckets;
  readonly graceMints: KeyedBuckets;
  /* LIVE-2E */
  readonly profileCreates: IpBuckets;
  readonly profileCreatesGlobal: KeyedBuckets;
  readonly credentialRedeems: IpBuckets;
  readonly credentialRedeemsPerSession: KeyedBuckets;
  readonly profileActions: KeyedBuckets;
  readonly cooldowns: MalformedCooldowns;
  readonly denied: DeniedCounters = {};

  constructor(limits: IdentityLimits, now: () => number) {
    const factor = limits.ipv6AggregateFactor;
    const keys = limits.maxTrackedKeys;
    this.failedUpgrades = new IpBuckets(limits.failedUpgradesPerIp, now, factor, keys);
    this.upgrades = new IpBuckets(limits.upgradesPerIp, now, factor, keys);
    this.upgradesGlobal = new KeyedBuckets(limits.upgradesGlobal, now, 1);
    this.guestCreates = new IpBuckets(limits.guestCreatesPerIp, now, factor, keys);
    this.guestCreatesGlobal = new KeyedBuckets(limits.guestCreatesGlobal, now, 1);
    this.bootstraps = new KeyedBuckets(limits.bootstrapsPerSession, now, keys);
    this.graceMints = new KeyedBuckets(limits.graceMintsPerSession, now, keys);
    this.profileCreates = new IpBuckets(limits.profileCreatesPerIp, now, factor, keys);
    this.profileCreatesGlobal = new KeyedBuckets(limits.profileCreatesGlobal, now, 1);
    this.credentialRedeems = new IpBuckets(limits.credentialRedeemsPerIp, now, factor, keys);
    this.credentialRedeemsPerSession = new KeyedBuckets(limits.credentialRedeemsPerSession, now, keys);
    this.profileActions = new KeyedBuckets(limits.profileActionsPerSession, now, keys);
    this.cooldowns = new MalformedCooldowns(
      limits.malformedClosesForCooldown,
      limits.malformedCloseWindowMs,
      limits.malformedCooldownMs,
      now,
      keys,
    );
  }

  deny(name: string): void {
    this.denied[name] = (this.denied[name] ?? 0) + 1;
  }

  prune(): void {
    this.failedUpgrades.prune();
    this.upgrades.prune();
    this.upgradesGlobal.prune();
    this.guestCreates.prune();
    this.guestCreatesGlobal.prune();
    this.bootstraps.prune();
    this.graceMints.prune();
    this.profileCreates.prune();
    this.profileCreatesGlobal.prune();
    this.credentialRedeems.prune();
    this.credentialRedeemsPerSession.prune();
    this.profileActions.prune();
    this.cooldowns.prune();
  }

  /** How many keys the limiters hold (the memory-growth test reads it). */
  size(): number {
    return (
      this.failedUpgrades.size +
      this.upgrades.size +
      this.upgradesGlobal.size +
      this.guestCreates.size +
      this.guestCreatesGlobal.size +
      this.bootstraps.size +
      this.graceMints.size +
      this.profileCreates.size +
      this.profileCreatesGlobal.size +
      this.credentialRedeems.size +
      this.credentialRedeemsPerSession.size +
      this.profileActions.size +
      this.cooldowns.size
    );
  }
}

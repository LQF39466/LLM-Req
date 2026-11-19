// One window is shared by every job using the same upstream quota.
export function controlKey(config) {
  return config.provider === "opencode" ? `opencode:${config.model}` : config.provider;
}

export class ConcurrencyWindow {
  #maximum;
  #spacing;
  #saturated = false;

  constructor(maximum, spacing, now, saved) {
    this.#maximum = maximum;
    this.#spacing = spacing;
    Object.assign(this, {
      version: 2, epoch: 0, mode: "probe", cap: Math.min(4, maximum),
      interval: spacing, next: 0, cooldown: 0, failures: 0,
    }, saved);
    if (saved && saved.version !== 2) {
      this.migration = { previousInterval: this.interval, at: now };
      this.interval = Math.min(this.interval, Math.max(250, spacing));
      this.next = Math.max(now, this.cooldown);
      this.version = 2;
    }
    if (this.mode === "fixed") this.mode = "adaptive";
    this.cap = Math.min(this.cap, maximum);
    if (this.mode === "probe" && this.epoch === 0) {
      this.interval = spacing;
      this.next = Math.max(now, this.cooldown);
    }
    this.interval = Math.max(spacing, this.interval);
    this.healthy = 0;
    this.stableSince = Math.max(now, this.cooldown);
  }

  resume(now) {
    this.next = now;
    this.cooldown = 0;
    this.failures = 0;
    this.healthy = 0;
    this.#saturated = false;
    this.stableSince = now;
    this.resumeEpoch = ++this.epoch;
  }

  limited(attempt, load, checking, retryAfter, now) {
    if (attempt.epoch < (this.resumeEpoch ?? 0)) return;
    if (attempt.epoch === this.epoch) {
      // Concurrent 429s from the same window consume a single decrease.
      if (this.mode === "adaptive" || checking)
        this.interval = Math.max(this.#spacing, Math.min(60_000, Math.max(250, this.interval * 2)));
      if (!checking) {
        this.observed = Math.max(attempt.load, load);
        this.cap = Math.max(1, Math.floor(Math.min(this.cap, this.observed) * 0.7));
        this.detectedAt = now;
        this.mode = "adaptive";
      }
      this.epoch++;
      this.healthy = 0;
      this.#saturated = false;
      this.cooldown = Math.max(this.cooldown, now + (retryAfter || 60_000));
    } else if (retryAfter > 0) {
      this.cooldown = Math.max(this.cooldown, now + retryAfter);
    } else return;
    this.next = Math.max(this.next, this.cooldown);
    this.stableSince = Math.max(now, this.cooldown);
  }

  unavailable(attempt, kind, retryAfter, now) {
    if (attempt.epoch < (this.resumeEpoch ?? 0)) return;
    let delay = retryAfter;
    if (kind === "unsent") delay = Math.max(delay, 300_000);
    else if (kind === "transient") {
      this.failures++;
      if (this.failures >= 3) delay = Math.max(delay, 60_000);
    } else return;
    if (delay) this.cooldown = Math.max(this.cooldown, now + delay);
    this.healthy = 0;
    this.#saturated = false;
    this.stableSince = Math.max(now, this.cooldown);
  }

  succeeded(attempt, now) {
    if (attempt.epoch !== this.epoch || attempt.started < Math.max(this.stableSince, this.cooldown)) return;
    this.failures = 0;
    if (attempt.cap !== this.cap) return;
    this.healthy++;
    this.#saturated ||= attempt.load >= this.cap;
    if (this.mode === "probe" && this.interval === this.#spacing) {
      if (!this.#saturated || this.healthy < this.cap || this.cap === this.#maximum) return;
      this.cap = Math.min(this.#maximum, this.cap * 2);
    } else {
      if (this.healthy < 10 || now - this.stableSince < 60_000) return;
      if (this.interval > this.#spacing) {
        this.interval = Math.max(this.#spacing, Math.floor(this.interval / 2));
        this.next = Math.max(this.cooldown, Math.min(this.next, now + this.interval));
      } else if (this.#saturated && this.cap < this.#maximum) {
        this.cap++;
      }
    }
    this.healthy = 0;
    this.#saturated = false;
    this.stableSince = now;
  }
}

/**
 * Fixed-rate tick driver for the authoritative server.
 *
 * Schedules against absolute deadlines rather than chaining fixed delays, so
 * timer jitter never accumulates into drift. If the process stalls, at most
 * `maxCatchUp` ticks run back to back and the rest are dropped — slowing the
 * world briefly is better than a spiral of death.
 */
export class TickLoop {
  private timer: ReturnType<typeof setTimeout> | null = null;
  private next = 0;
  /** Exponential moving average of tick cost in ms, for load reporting. */
  avgTickMs = 0;

  constructor(
    readonly hz: number,
    private readonly onTick: (dt: number) => void,
    private readonly maxCatchUp = 5,
  ) {}

  start(): void {
    if (this.timer) return;
    this.next = performance.now();
    this.schedule();
  }

  stop(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
  }

  private schedule(): void {
    this.timer = setTimeout(() => this.run(), Math.max(0, this.next - performance.now()));
  }

  private run(): void {
    const interval = 1000 / this.hz;
    let ran = 0;
    while (performance.now() >= this.next && ran < this.maxCatchUp) {
      const t0 = performance.now();
      this.onTick(1 / this.hz);
      this.avgTickMs += (performance.now() - t0 - this.avgTickMs) * 0.05;
      this.next += interval;
      ran++;
    }
    if (performance.now() > this.next) this.next = performance.now();
    this.schedule();
  }
}

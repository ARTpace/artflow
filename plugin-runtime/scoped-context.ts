/** Trusted in-process lifecycle ownership, NOT a security sandbox. */
import { Kernel, ContributionRegistry, type Contribution, type SlotName, type Effect, type KernelEventHandler } from './kernel';

type Phase = 'activating' | 'active' | 'quiescing' | 'disposed';
type Lease = { start: () => Effect; stop?: Effect; cancelPending: Effect; live: boolean };
export type ScopedContribution<T> = Omit<Contribution<T>, 'pluginId'> & { pluginId?: string };

class ScopedContributions extends ContributionRegistry {
  private readonly pending = new ContributionRegistry();
  constructor(private owner: ScopedPluginContext, private root: Kernel) { super(); }
  override register<T>(slot: SlotName, item: ScopedContribution<T>): Effect {
    this.owner.assertWritable();
    if (item.pluginId !== undefined && item.pluginId !== this.owner.pluginId) throw new Error('contribution owner mismatch');
    if (this.root.contributions.get(slot, item.id)) throw new Error(`duplicate contribution ${slot}/${item.id}`);
    const entry = { ...item, pluginId: this.owner.pluginId };
    const undoPending = this.pending.register(slot, entry);
    return this.owner.lease(() => {
      const undo = this.root.contributions.register(slot, entry);
      return () => { undo(); undoPending(); };
    }, undoPending);
  }
  override list<T = unknown>(slot: SlotName): readonly Contribution<T>[] {
    const entries = new Map(this.root.contributions.list<T>(slot).map(e => [e.id, e]));
    for (const e of this.pending.list<T>(slot)) entries.set(e.id, e);
    return [...entries.values()].sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0) || a.id.localeCompare(b.id));
  }
  override get<T = unknown>(slot: SlotName, id: string): Contribution<T> | undefined {
    return this.pending.get<T>(slot, id) ?? this.root.contributions.get<T>(slot, id);
  }
}

export class ScopedPluginContext extends Kernel {
  override readonly contributions: ScopedContributions;
  private phase: Phase = 'activating';
  private readonly controller = new AbortController();
  readonly signal = this.controller.signal;
  private readonly leases = new Set<Lease>();
  private readonly ownServices = new Map<string, unknown>();
  private readonly queuedEvents: { topic: string; payload: unknown }[] = [];
  private readonly tasks = new Set<Promise<unknown>>();
  readonly effects = {
    defer: (cleanup: Effect): Effect => this.lease(() => cleanup, cleanup),
    setTimeout: (callback: () => void, ms: number): Effect => this.timer(callback, ms, false),
    setInterval: (callback: () => void, ms: number): Effect => this.timer(callback, ms, true),
    track: <T>(work: (signal: AbortSignal) => Promise<T>): Promise<T> => {
      this.assertWritable();
      const promise = Promise.resolve().then(() => {
        if (this.signal.aborted) throw new Error('plugin scope aborted');
        return work(this.signal);
      });
      this.tasks.add(promise);
      void promise.then(() => this.tasks.delete(promise), () => this.tasks.delete(promise));
      return promise;
    },
  };
  constructor(private readonly root: Kernel, readonly pluginId: string) {
    super();
    this.contributions = new ScopedContributions(this, root);
  }
  get status(): Phase { return this.phase; }
  get pendingCalls(): number { return this.tasks.size; }
  assertWritable(): void {
    if (this.phase !== 'activating' && this.phase !== 'active') throw new Error(`plugin scope ${this.phase}: ${this.pluginId}`);
  }
  /** Loader internal. Not a public security boundary. */
  lease(start: () => Effect, cancelPending: Effect = () => {}): Effect {
    this.assertWritable();
    const lease: Lease = { start, cancelPending, live: true };
    this.leases.add(lease);
    const cancel = () => {
      if (!lease.live) return;
      lease.live = false;
      this.leases.delete(lease);
      (lease.stop ?? lease.cancelPending)();
    };
    if (this.phase === 'active') {
      try { lease.stop = start(); } catch (error) { this.safe(cancel); throw error; }
    }
    return cancel;
  }
  override provide<T>(name: string, value: T, dispose?: Effect): Effect {
    this.assertWritable();
    if (this.has(name)) throw new Error(`service already provided: ${name}`);
    this.ownServices.set(name, value);
    const pendingCleanup = () => { this.ownServices.delete(name); dispose?.(); };
    return this.lease(() => {
      const undo = this.root.provide(name, value, dispose);
      return () => { this.ownServices.delete(name); undo(); };
    }, pendingCleanup);
  }
  override has(name: string): boolean { return this.ownServices.has(name) || this.root.has(name); }
  override use<T = unknown>(name: string): T {
    if (this.phase === 'disposed') throw new Error('plugin scope disposed');
    return this.ownServices.has(name) ? this.ownServices.get(name) as T : this.root.use<T>(name);
  }
  override on(topic: string, handler: KernelEventHandler): Effect {
    return this.lease(() => this.root.on(topic, payload => { if (this.phase === 'active') handler(payload); }));
  }
  override emit(topic: string, payload?: unknown): void {
    this.assertWritable();
    if (this.phase === 'activating') {
      if (this.queuedEvents.length >= 1024) throw new Error('activation event buffer exceeded');
      this.queuedEvents.push({ topic, payload });
    } else this.root.emit(topic, payload);
  }
  private timer(callback: () => void, ms: number, repeat: boolean): Effect {
    if (!Number.isFinite(ms) || ms < 0) throw new Error('invalid timer delay');
    return this.lease(() => {
      const run = () => { if (this.phase === 'active') this.safe(callback); };
      if (repeat) { const id = globalThis.setInterval(run, ms); return () => globalThis.clearInterval(id); }
      const id = globalThis.setTimeout(run, ms); return () => globalThis.clearTimeout(id);
    });
  }
  commit(): void {
    if (this.phase !== 'activating') throw new Error('scope cannot commit');
    // No await or observer callback between publication of the individual leases.
    try { for (const lease of this.leases) if (lease.live) lease.stop = lease.start(); }
    catch (error) { this.close(); throw error; }
    this.phase = 'active';
    const events = this.queuedEvents.splice(0);
    for (const event of events) { if (this.phase !== 'active') break; this.root.emit(event.topic, event.payload); }
  }
  quiesce(): void {
    if (this.phase === 'disposed' || this.phase === 'quiescing') return;
    this.phase = 'quiescing';
    this.controller.abort();
    this.queuedEvents.length = 0;
  }
  async drain(timeoutMs: number): Promise<boolean> {
    if (this.tasks.size === 0) return false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        Promise.allSettled([...this.tasks]).then(() => false),
        new Promise<boolean>(resolve => { timer = setTimeout(() => resolve(true), timeoutMs); }),
      ]);
    } finally { if (timer !== undefined) clearTimeout(timer); }
  }
  close(): void {
    if (this.phase === 'disposed') return;
    this.quiesce();
    for (const lease of [...this.leases].reverse()) {
      if (!lease.live) continue;
      lease.live = false;
      this.leases.delete(lease);
      this.safe(lease.stop ?? lease.cancelPending);
    }
    this.ownServices.clear();
    this.phase = 'disposed';
  }
  private safe(cleanup: Effect): void {
    try { cleanup(); } catch (error) { console.error(`[plugin:${this.pluginId}] cleanup/callback failed`, error); }
  }
}

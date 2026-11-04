// A concierge is a single Agent session. Keep notifications for that
// session ordered even when multiple goals or CLI writes arrive together.
export class CoordinatorQueue {
  private readonly queues = new Map<string, Promise<void>>();

  run<T>(key: string, task: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve();
    const current = previous.catch(() => {}).then(task);
    const settled = current.then(() => {}, () => {});
    this.queues.set(key, settled);
    void settled.finally(() => {
      if (this.queues.get(key) === settled) this.queues.delete(key);
    });
    return current;
  }
}

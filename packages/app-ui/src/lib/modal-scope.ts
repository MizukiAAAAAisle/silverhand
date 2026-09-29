/** Mounted modal ownership, shared by Web overlays and native navigation. */
export class ModalScope {
  private owners = new Set<symbol>();
  private listeners = new Set<() => void>();
  private revision = 0;

  get blocked() {
    return this.owners.size > 0;
  }
  get version() {
    return this.revision;
  }

  acquire() {
    const owner = Symbol();
    this.owners.add(owner);
    this.publish();
    return () => {
      if (this.owners.delete(owner)) this.publish();
    };
  }

  subscribe(listener: () => void) {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private publish() {
    this.revision += 1;
    for (const listener of this.listeners) listener();
  }
}

export const modalScope = new ModalScope();

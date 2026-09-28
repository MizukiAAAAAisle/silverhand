/** Reject asynchronous work that belongs to an earlier account or server. */
export class SessionGeneration {
  private value = 0;

  capture(): () => boolean {
    const value = this.value;
    return () => value === this.value;
  }

  invalidate(): void {
    this.value += 1;
  }
}

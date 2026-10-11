export type HoldSource = 'space' | 'enter' | number;

/** One physical hold owns a recording. Repeats/other pointers cannot send it twice. */
export class HoldToTalk {
  private source: HoldSource | null = null;
  constructor(private readonly actions: { canStart(): boolean; start(): void; send(): void; cancel(): void }) {}
  begin(source: HoldSource): boolean {
    if (this.source !== null || !this.actions.canStart()) return false;
    this.source = source; this.actions.start(); return true;
  }
  end(source: HoldSource): boolean {
    if (this.source !== source) return false;
    this.source = null; this.actions.send(); return true;
  }
  cancel(source?: HoldSource): void {
    if (this.source === null || (source !== undefined && this.source !== source)) return;
    this.source = null; this.actions.cancel();
  }
  owns(source: HoldSource): boolean { return this.source === source; }
}

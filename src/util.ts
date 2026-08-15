/** Small shared helpers. Nothing here should know about any specific tool. */

export interface TruncationResult {
  text: string;
  truncated: boolean;
}

/**
 * Cap text at `limit` characters, keeping the head and the tail.
 *
 * Build output puts the useful material at both ends — the command line and
 * early compile errors at the top, the failure summary at the bottom — so a
 * plain head-truncation throws away the half that usually answers the question.
 */
export function truncateMiddle(text: string, limit: number): TruncationResult {
  if (text.length <= limit) return { text, truncated: false };
  const head = Math.floor(limit * 0.4);
  const tail = limit - head;
  const omitted = text.length - limit;
  return {
    text:
      text.slice(0, head) +
      `\n\n… [${omitted.toLocaleString()} characters omitted] …\n\n` +
      text.slice(text.length - tail),
    truncated: true,
  };
}

/** Format a byte count for human-readable tool output. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

/**
 * A mutex admitting exactly one holder, with no queue.
 *
 * Callers that arrive while the lock is held are rejected rather than parked.
 * For build tooling that is the honest behaviour: two concurrent `mill` or
 * `sbt` invocations in one checkout contend for the same build lock and
 * target directory, so queueing would just hide the conflict behind a timeout.
 */
export class SingleFlight {
  #busySince: number | null = null;

  get busy(): boolean {
    return this.#busySince !== null;
  }

  /** Seconds the current holder has been running, or null if idle. */
  get heldForSeconds(): number | null {
    return this.#busySince === null ? null : Math.round((Date.now() - this.#busySince) / 1000);
  }

  async run<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#busySince !== null) {
      throw new Error(
        `A run is already in progress (started ${this.heldForSeconds}s ago). ` +
          `Concurrent runs are refused because they would contend for the same ` +
          `build lock. Wait for the current run to finish and try again.`,
      );
    }
    this.#busySince = Date.now();
    try {
      return await fn();
    } finally {
      this.#busySince = null;
    }
  }
}

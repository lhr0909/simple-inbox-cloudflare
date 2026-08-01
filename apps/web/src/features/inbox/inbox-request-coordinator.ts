export type LatestRequestTicket = Readonly<{
  signal: AbortSignal
  isLatest: () => boolean
}>

/**
 * Coordinates one logical request lane. Starting a newer request aborts the
 * previous transport when possible and, independently, prevents a late result
 * from committing state when the transport cannot be cancelled.
 */
export class LatestRequestCoordinator {
  private controller: AbortController | null = null
  private generation = 0

  begin(): LatestRequestTicket {
    this.controller?.abort()
    const controller = new AbortController()
    const generation = ++this.generation
    this.controller = controller

    return {
      signal: controller.signal,
      isLatest: () => generation === this.generation && !controller.signal.aborted,
    }
  }

  invalidate(): void {
    this.generation += 1
    this.controller?.abort()
    this.controller = null
  }
}

export function isAbortError(cause: unknown): boolean {
  return cause instanceof DOMException && cause.name === 'AbortError'
}

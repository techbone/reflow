/**
 * Minimal Bun ambient declarations for TypeScript type-checking.
 * Only the APIs used by server/index.ts are declared here.
 * The real runtime is Bun 1.x; these types match the subset we use.
 */

declare const Bun: {
  serve(options: {
    port: number
    fetch: (req: Request) => Response | Promise<Response>
  }): {
    requestIP(req: Request): { address: string; port: number; family: string } | null
  }
}

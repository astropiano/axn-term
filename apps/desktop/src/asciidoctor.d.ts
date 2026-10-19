// asciidoctor 4.x ships types under `types/` but its package.json `exports`
// map does not expose them, so TypeScript cannot resolve them for the bare
// module specifier. Declare the surface we use (lazy-loaded via import()).
declare module 'asciidoctor' {
  export function convert(
    input: string | string[],
    options?: Record<string, unknown>,
  ): Promise<string>;
}

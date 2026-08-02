/**
 * Test stub for the `server-only` package.
 *
 * The real module throws on import outside a React Server Component, which is
 * the guard we want in production but which also makes server modules
 * untestable under Vitest. Aliasing it here keeps the guard shipping while
 * letting the suite import the modules it protects.
 */
export {};

/**
 * The bundled Worker as Miniflare's explicit module list. With `modules: true`
 * Miniflare scans the bundle's imports and refuses evlog's computed `import()`,
 * which the Worker never reaches because its log drain is configured explicitly.
 */
export const workerModules = (contents: string) => [
  { contents, path: "worker.js", type: "ESModule" as const },
];

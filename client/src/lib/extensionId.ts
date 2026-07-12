// Extension ids are "publisher.name" (server/src/extensions.ts's resolveId) —
// derives the publisher half for display when no explicit publisher field is
// available (an installed ExtensionInfo has none; a registry entry does).
export function parsePublisher(id: string): string | undefined {
  const dot = id.indexOf(".");
  return dot === -1 ? undefined : id.slice(0, dot);
}

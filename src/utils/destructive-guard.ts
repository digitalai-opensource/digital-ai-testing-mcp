// Callers must return the result as a plain content response — do NOT set isError: true.
// isError causes MCP clients to treat the response as a tool failure, which prevents
// the LLM from reading the "include confirmDeletion: true" instruction inside the message.
export function checkDestructiveGuard(
  confirmDeletion: boolean | undefined,
  operationDescription: string
): string | null {
  if (confirmDeletion !== true) {
    return (
      `⚠️  Safety guard triggered.\n\n` +
      `"${operationDescription}" is a destructive operation that cannot be undone.\n\n` +
      `To confirm you want to proceed, include confirmDeletion: true in your request.\n\n` +
      `No changes were made.`
    );
  }
  return null;
}

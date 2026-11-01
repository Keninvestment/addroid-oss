/** Keep a listener for the entire pool lifetime, including startup/shutdown. */
export function attachQueueErrorHandler(
  boss: { on: (event: "error", listener: (raw: unknown) => void) => unknown },
  onError?: (error: Error) => void
): void {
  boss.on("error", (raw: unknown) => {
    const error = raw instanceof Error ? raw : new Error(String(raw));
    if (onError) onError(error);
    else console.error("[queue] pg-boss error:", error.message);
  });
}


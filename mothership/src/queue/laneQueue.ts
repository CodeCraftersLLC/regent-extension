/**
 * Lane Queue — per-session serial execution.
 * Pattern from OpenClaw: prevents race conditions by ensuring
 * tasks for the same session execute one at a time.
 *
 * Key format: "ws:{workspaceId}:sess:{sessionId}"
 * Each key chains promises so tasks run sequentially.
 */

const lanes = new Map<string, Promise<void>>();

export function enqueue(key: string, task: () => Promise<void>): Promise<void> {
  const prev = lanes.get(key) ?? Promise.resolve();
  const next = prev
    .then(task)
    .catch(() => {}) // Don't let one failure block the lane
    .finally(() => {
      // Clean up lane if nothing else queued
      if (lanes.get(key) === next) lanes.delete(key);
    });

  lanes.set(key, next);
  return next;
}

export function laneKey(workspaceId: string, sessionId: string) {
  return `ws:${workspaceId}:sess:${sessionId}`;
}

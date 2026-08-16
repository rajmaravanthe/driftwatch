import type { Response } from "express";
import type { ServerSentEvent } from "../shared/types.js";
import type { EventSink } from "./engine/runner.js";

/**
 * In-memory SSE hub. Clients subscribe to a run's event stream; the workflow
 * runner broadcasts every mutation through this bus. If a client reconnects
 * mid-run it receives the next event immediately; the UI also re-hydrates
 * current state from the REST API on connect.
 */
class SseHub implements EventSink {
  private clients = new Map<string, Set<Response>>();

  subscribe(runId: string, res: Response): void {
    let set = this.clients.get(runId);
    if (!set) {
      set = new Set();
      this.clients.set(runId, set);
    }
    set.add(res);
    res.on("close", () => this.unsubscribe(runId, res));
  }

  unsubscribe(runId: string, res: Response): void {
    const set = this.clients.get(runId);
    if (!set) return;
    set.delete(res);
    if (set.size === 0) this.clients.delete(runId);
  }

  broadcast(runId: string, event: ServerSentEvent): void {
    const set = this.clients.get(runId);
    if (!set) return;
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const res of set) {
      res.write(payload);
    }
  }
}

export const sseHub = new SseHub();

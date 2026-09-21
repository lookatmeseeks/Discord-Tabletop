import { DurableObject } from "cloudflare:workers";

const DEFAULT_STATE = {
  pieces: {
    A: { x: 15, y: 20 },
    B: { x: 35, y: 35 },
    C: { x: 55, y: 50 },
    D: { x: 75, y: 65 }
  }
};

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (url.pathname !== "/websocket") {
      return new Response("Discord Tabletop sync worker is running.", {
        headers: { "content-type": "text/plain; charset=utf-8" }
      });
    }

    if (request.method !== "GET" || request.headers.get("Upgrade")?.toLowerCase() !== "websocket") {
      return new Response("WebSocket upgrade required.", { status: 426 });
    }

    const roomId = url.searchParams.get("room");
    if (!roomId || roomId.length > 200) {
      return new Response("Missing or invalid room.", { status: 400 });
    }

    const id = env.TABLETOP_ROOM.idFromName(roomId);
    return env.TABLETOP_ROOM.get(id).fetch(request);
  }
};

export class TabletopRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.state = null;
    this.sessions = new Map();

    for (const ws of this.ctx.getWebSockets()) {
      const attachment = ws.deserializeAttachment();
      if (attachment?.sessionId) {
        this.sessions.set(ws, attachment);
      }
    }

    this.ctx.setWebSocketAutoResponse(
      new WebSocketRequestResponsePair("ping", "pong")
    );
  }

  async getState() {
    if (this.state) return this.state;

    const stored = await this.ctx.storage.get("state");
    this.state = stored ?? structuredClone(DEFAULT_STATE);

    return this.state;
  }

  async saveState() {
    await this.ctx.storage.put("state", this.state);
  }

  async fetch(request) {
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);

    this.ctx.acceptWebSocket(server);

    const sessionId = crypto.randomUUID();
    server.serializeAttachment({ sessionId });
    this.sessions.set(server, { sessionId });

    server.send(JSON.stringify({
      type: "state",
      state: await this.getState()
    }));

    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  async webSocketMessage(ws, message) {
    let data;

    try {
      data = JSON.parse(typeof message === "string"
        ? message
        : new TextDecoder().decode(message));
    } catch {
      return;
    }

    if (data?.type !== "move") return;

    const id = data.pieceId;
    const x = Number(data.x);
    const y = Number(data.y);

    if (!["A", "B", "C", "D"].includes(id)) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;

    const state = await this.getState();
    state.pieces[id] = {
      x: Math.max(0, Math.min(100, x)),
      y: Math.max(0, Math.min(100, y))
    };

    await this.saveState();

    const payload = JSON.stringify({
      type: "move",
      pieceId: id,
      x: state.pieces[id].x,
      y: state.pieces[id].y
    });

    for (const connected of this.sessions.keys()) {
      try {
        connected.send(payload);
      } catch {
        this.sessions.delete(connected);
      }
    }
  }

  async webSocketClose(ws, code, reason) {
    this.sessions.delete(ws);
    ws.close(code, reason);
  }
}

import { DurableObject } from "cloudflare:workers";

const DEFAULT_STATE = {
  version: 3,
  objects: []
}

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

    if (stored?.version === 3 && Array.isArray(stored.objects)) {
      this.state = stored;
    } else {
      this.state = structuredClone(DEFAULT_STATE);
      await this.ctx.storage.put("state", this.state);
    }

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

    if (data?.type === "addRectangle") {
      const state = await this.getState();
      const object = {
        id: "rectangle-" + crypto.randomUUID(),
        type: "rectangle",
        x: Number.isFinite(Number(data.x)) ? Math.max(0, Math.min(100, Number(data.x))) : 50,
        y: Number.isFinite(Number(data.y)) ? Math.max(0, Math.min(100, Number(data.y))) : 50,
        width: Math.max(30, Math.min(1000, Number(data.width) || 200)),
        height: Math.max(30, Math.min(1000, Number(data.height) || 120))
      };

      state.objects.push(object);
      await this.saveState();

      const payload = JSON.stringify({ type: "objectAdded", object });
      for (const connected of this.sessions.keys()) {
        try { connected.send(payload); } catch { this.sessions.delete(connected); }
      }
      return;
    }



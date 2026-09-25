import { DurableObject } from "cloudflare:workers";

const DEFAULT_STATE = {
  version: 3,
  objects: []
};

const SAVE_KEY = "default";

function cloneState(state) {
  return structuredClone({
    version: 3,
    objects: (state?.objects || []).filter(object => object?.type === "rectangle")
  });
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
    this.env = env;
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

  async getSavedState() {
    const id = this.env.TABLETOP_SAVE.idFromName(SAVE_KEY);
    const response = await this.env.TABLETOP_SAVE.get(id).fetch("https://tabletop-save/state");

    if (!response.ok) {
      throw new Error(`Could not load saved board: HTTP ${response.status}`);
    }

    const saved = await response.json();
    if (saved?.version === 3 && Array.isArray(saved.objects)) {
      return cloneState(saved);
    }

    return structuredClone(DEFAULT_STATE);
  }

  async getState() {
    if (this.state) return this.state;

    this.state = await this.getSavedState();
    return this.state;
  }

  async saveBoard() {
    const snapshot = cloneState(this.state);
    const id = this.env.TABLETOP_SAVE.idFromName(SAVE_KEY);
    const response = await this.env.TABLETOP_SAVE.get(id).fetch("https://tabletop-save/state", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(snapshot)
    });

    if (!response.ok) {
      throw new Error(`Could not save board: HTTP ${response.status}`);
    }
  }

  broadcast(payload) {
    for (const connected of this.sessions.keys()) {
      try {
        connected.send(payload);
      } catch {
        this.sessions.delete(connected);
      }
    }
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

    if (data?.type === "save") {
      try {
        await this.saveBoard();
        this.broadcast(JSON.stringify({
          type: "saved",
          savedAt: new Date().toISOString()
        }));
      } catch (error) {
        try {
          ws.send(JSON.stringify({
            type: "saveError",
            message: error instanceof Error ? error.message : "Could not save board."
          }));
        } catch {}
      }
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
        height: Math.max(30, Math.min(1000, Number(data.height) || 120)),
        layer: "foreground",
        rotation: 0
      };

      state.objects.push(object);

      this.broadcast(JSON.stringify({ type: "objectAdded", object }));
      return;
    }

    if (data?.type === "delete") {
      const id = data.objectId;
      if (!id) return;

      const state = await this.getState();
      const index = state.objects.findIndex(item => item.id === id);

      if (index === -1) return;

      state.objects.splice(index, 1);

      this.broadcast(JSON.stringify({
        type: "deleted",
        objectId: id
      }));

      return;
    }

    if (data?.type === "setAsset") {
      const id = data.objectId;
      const path = typeof data.path === "string" ? data.path : "";

      if (!id || !/^assets\/.+\.(png|jpe?g|gif|webp|svg)$/i.test(path)) {
        return;
      }

      const state = await this.getState();
      const object = state.objects.find(item => item.id === id);

      if (!object || object.type !== "rectangle") return;

      const imageWidth = Number(data.imageWidth);
      const imageHeight = Number(data.imageHeight);
      if (!Number.isFinite(imageWidth) || !Number.isFinite(imageHeight) || imageWidth <= 0 || imageHeight <= 0) return;

      object.texture = path;
      object.aspectRatio = imageWidth / imageHeight;
      object.height = object.width / object.aspectRatio;

      this.broadcast(JSON.stringify({
        type: "asset",
        objectId: object.id,
        assetType: "texture",
        path,
        aspectRatio: object.aspectRatio
      }));

      return;
    }

    if (data?.type === "lock") {
      const id = data.objectId;
      if (!id || typeof data.locked !== "boolean") return;

      const state = await this.getState();
      const object = state.objects.find(item => item.id === id);
      if (!object || object.type !== "rectangle") return;

      object.locked = data.locked;

      this.broadcast(JSON.stringify({
        type: "lock",
        objectId: object.id,
        locked: object.locked
      }));
      return;
    }

    if (data?.type === "layer") {
      const id = data.objectId;
      const layer = data.layer === "background" ? "background" : "foreground";
      if (!id) return;

      const state = await this.getState();
      const object = state.objects.find(item => item.id === id);
      if (!object || object.type !== "rectangle") return;

      object.layer = layer;

      this.broadcast(JSON.stringify({
        type: "layer",
        objectId: object.id,
        layer: object.layer
      }));
      return;
    }

    if (data?.type === "note") {
      const id = data.objectId;
      const note = typeof data.note === "string" ? data.note.slice(0, 10000) : "";
      if (!id) return;

      const state = await this.getState();
      const object = state.objects.find(item => item.id === id);
      if (!object || object.type !== "rectangle") return;

      object.note = note;

      this.broadcast(JSON.stringify({
        type: "note",
        objectId: object.id,
        note: object.note
      }));
      return;
    }

    if (data?.type === "rotate") {
      const id = data.objectId;
      const rotation = Number(data.rotation);
      if (!id || !Number.isFinite(rotation)) return;

      const state = await this.getState();
      const object = state.objects.find(item => item.id === id);
      if (!object || object.type !== "rectangle") return;

      object.rotation = ((rotation % 360) + 360) % 360;

      this.broadcast(JSON.stringify({
        type: "rotate",
        objectId: object.id,
        rotation: object.rotation
      }));

      return;
    }

    if (data?.type === "resize") {
      const id = data.objectId;
      const width = Number(data.width);
      const height = Number(data.height);
      if (!id || !Number.isFinite(width) || !Number.isFinite(height)) return;

      const state = await this.getState();
      const object = state.objects.find(item => item.id === id);
      if (!object || object.type !== "rectangle" || !object.aspectRatio) return;

      object.width = Math.max(30, Math.min(1000, width));
      object.height = object.width / object.aspectRatio;

      this.broadcast(JSON.stringify({
        type: "resize",
        objectId: object.id,
        width: object.width,
        height: object.height
      }));

      return;
    }

    if (data?.type === "link") {
      const objectIds = Array.isArray(data.objectIds) ? data.objectIds.slice(0, 2) : [];
      const linkId = typeof data.linkId === "string" ? data.linkId.slice(0, 100) : "";
      if (objectIds.length !== 2 || new Set(objectIds).size !== 2 || !linkId) return;

      const state = await this.getState();
      const objects = objectIds.map(id => state.objects.find(item => item.id === id));
      if (objects.some(object => !object || object.type !== "rectangle")) return;
      if (objects.some(object => object.locked || object.linkId)) return;

      for (const object of objects) object.linkId = linkId;

      this.broadcast(JSON.stringify({
        type: "link",
        objectIds,
        linkId
      }));
      return;
    }

    if (data?.type === "unlink") {
      const objectIds = Array.isArray(data.objectIds) ? data.objectIds.slice(0, 20) : [];
      if (!objectIds.length) return;

      const state = await this.getState();
      for (const objectId of objectIds) {
        const object = state.objects.find(item => item.id === objectId);
        if (object) delete object.linkId;
      }

      this.broadcast(JSON.stringify({
        type: "unlink",
        objectIds
      }));
      return;
    }

    if (data?.type !== "move") return;

    const id = data.objectId;
    const x = Number(data.x);
    const y = Number(data.y);

    if (!id || !Number.isFinite(x) || !Number.isFinite(y)) return;

    const state = await this.getState();
    const object = state.objects.find(item => item.id === id);

    if (!object) return;

    const previousX = object.x;
    const previousY = object.y;
    object.x = Math.max(0, Math.min(100, x));
    object.y = Math.max(0, Math.min(100, y));

    const deltaX = object.x - previousX;
    const deltaY = object.y - previousY;

    if (object.linkId) {
      const movedObjects = [];
      for (const linked of state.objects) {
        if (linked.type !== "rectangle" || linked.linkId !== object.linkId) continue;
        if (linked.id !== object.id) {
          linked.x = Math.max(0, Math.min(100, linked.x + deltaX));
          linked.y = Math.max(0, Math.min(100, linked.y + deltaY));
        }
        movedObjects.push({
          id: linked.id,
          x: linked.x,
          y: linked.y
        });
      }

      this.broadcast(JSON.stringify({
        type: "groupMove",
        objects: movedObjects
      }));
      return;
    }

    this.broadcast(JSON.stringify({
      type: "move",
      objectId: object.id,
      x: object.x,
      y: object.y
    }));
  }

  async webSocketClose(ws, code, reason) {
    this.sessions.delete(ws);
    ws.close(code, reason);
  }
}

export class TabletopSave extends DurableObject {
  async fetch(request) {
    const url = new URL(request.url);

    if (url.pathname !== "/state") {
      return new Response("Not found.", { status: 404 });
    }

    if (request.method === "GET") {
      const saved = await this.ctx.storage.get("state");
      return Response.json(saved || DEFAULT_STATE);
    }

    if (request.method === "POST") {
      let state;

      try {
        state = await request.json();
      } catch {
        return new Response("Invalid JSON.", { status: 400 });
      }

      if (state?.version !== 3 || !Array.isArray(state.objects)) {
        return new Response("Invalid board state.", { status: 400 });
      }

      await this.ctx.storage.put("state", cloneState(state));
      return new Response(null, { status: 204 });
    }

    return new Response("Method not allowed.", { status: 405 });
  }
}

import path from "node:path";
import { fileURLToPath } from "node:url";
import express from "express";
import { Server } from "socket.io";
import http from "node:http";
import {
  addPlayerToBattle,
  createBattle,
  createGameStore,
  ensureSession,
  fireBullet,
  listBattles,
  publicBattle,
  removePlayerFromBattle,
  serializeBattleState,
  tickBattle,
  updatePlayerInput,
  WORLD
} from "./game.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, "..");
const isProduction = process.env.NODE_ENV === "production";
const port = Number(process.env.PORT) || 3000;
const host = process.env.HOST || (isProduction ? "127.0.0.1" : "0.0.0.0");

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: "*" }
});
const store = createGameStore();

app.use(express.json());

app.get("/api/health", (_req, res) => {
  res.json({ ok: true, battles: store.battles.size, world: WORLD });
});

if (isProduction) {
  app.use(express.static(path.join(rootDir, "dist")));
  app.get("*", (_req, res) => {
    res.sendFile(path.join(rootDir, "dist", "index.html"));
  });
} else {
  const { createServer } = await import("vite");
  const vite = await createServer({
    root: rootDir,
    server: { middlewareMode: true },
    appType: "spa"
  });
  app.use(vite.middlewares);
}

io.on("connection", (socket) => {
  socket.data.battleId = null;
  socket.data.session = null;

  socket.on("session:hello", (payload, reply) => {
    const session = ensureSession(store, payload);
    socket.data.session = session;
    reply?.({ ok: true, session });
    emitBattles();
  });

  socket.on("battle:list", (reply) => {
    reply?.({ ok: true, battles: listBattles(store) });
  });

  socket.on("battle:create", (payload, reply) => {
    const session = requireSession(socket, reply);
    if (!session) return;

    const battle = createBattle(store, session, payload);
    joinBattle(socket, battle, reply);
    emitBattles();
  });

  socket.on("battle:join", (payload, reply) => {
    const session = requireSession(socket, reply);
    if (!session) return;

    const battle = store.battles.get(String(payload?.battleId || "").toUpperCase());
    if (!battle) {
      reply?.({ ok: false, error: "Бой не найден" });
      return;
    }

    joinBattle(socket, battle, reply);
    emitBattles();
  });

  socket.on("battle:leave", (reply) => {
    leaveCurrentBattle(socket);
    reply?.({ ok: true });
    emitBattles();
  });

  socket.on("input:update", (payload) => {
    const battle = store.battles.get(socket.data.battleId);
    updatePlayerInput(battle, socket.id, payload);
  });

  socket.on("player:fire", () => {
    const battle = store.battles.get(socket.data.battleId);
    fireBullet(battle, socket.id);
  });

  socket.on("disconnect", () => {
    leaveCurrentBattle(socket);
    emitBattles();
  });
});

setInterval(() => {
  const now = Date.now();
  for (const battle of store.battles.values()) {
    if (battle.players.size === 0 && battle.emptySince && now - battle.emptySince > 60_000) {
      store.battles.delete(battle.id);
      continue;
    }

    tickBattle(battle, now);
    io.to(roomName(battle.id)).emit("world:state", serializeBattleState(battle));
  }
}, 1000 / WORLD.tickRate);

setInterval(emitBattles, 3000);

server.listen(port, host, () => {
  console.log(`Tank Arena listening on http://${host}:${port}`);
});

function joinBattle(socket, battle, reply) {
  leaveCurrentBattle(socket);

  const result = addPlayerToBattle(battle, socket.id, socket.data.session);
  if (!result.ok) {
    reply?.(result);
    return;
  }

  battle.emptySince = null;
  socket.data.battleId = battle.id;
  socket.join(roomName(battle.id));
  reply?.({
    ok: true,
    battle: publicBattle(battle),
    state: serializeBattleState(battle),
    selfSocketId: socket.id
  });
}

function leaveCurrentBattle(socket) {
  const battleId = socket.data.battleId;
  if (!battleId) {
    return;
  }

  socket.leave(roomName(battleId));
  removePlayerFromBattle(store, battleId, socket.id);
  socket.data.battleId = null;
}

function requireSession(socket, reply) {
  if (socket.data.session) {
    return socket.data.session;
  }

  reply?.({ ok: false, error: "Сессия не создана" });
  return null;
}

function roomName(battleId) {
  return `battle:${battleId}`;
}

function emitBattles() {
  io.emit("battles:update", listBattles(store));
}

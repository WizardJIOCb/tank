import crypto from "node:crypto";

export const WORLD = {
  width: 96,
  depth: 64,
  tickRate: 30,
  maxBulletsPerPlayer: 4,
  obstacles: [
    { id: "mid-a", x: -12, z: -8, w: 16, d: 5 },
    { id: "mid-b", x: 18, z: 10, w: 18, d: 5 },
    { id: "north", x: 0, z: -24, w: 22, d: 4 },
    { id: "south", x: -26, z: 22, w: 18, d: 4 }
  ]
};

const PLAYER_RADIUS = 1.6;
const BULLET_RADIUS = 0.45;
const PLAYER_SPEED = 20;
const TURN_RATE = 8;
const FIRE_COOLDOWN_MS = 520;
const BULLET_SPEED = 42;
const BULLET_TTL = 1.9;
const RESPAWN_MS = 1600;

const colors = [0x4dd7a2, 0x67a8ff, 0xffcf5a, 0xff6f91, 0xb58cff, 0x5ee0ff];

export function createGameStore() {
  return {
    battles: new Map(),
    sessions: new Map()
  };
}

export function publicBattle(battle) {
  return {
    id: battle.id,
    name: battle.name,
    createdAt: battle.createdAt,
    playerCount: battle.players.size,
    maxPlayers: battle.maxPlayers,
    status: battle.players.size >= battle.maxPlayers ? "full" : "open"
  };
}

export function listBattles(store) {
  return [...store.battles.values()]
    .filter((battle) => battle.players.size > 0 || Date.now() - battle.createdAt < 30 * 60 * 1000)
    .sort((a, b) => b.createdAt - a.createdAt)
    .map(publicBattle);
}

export function createSession(store, payload = {}) {
  const sessionId = sanitizeId(payload.sessionId) || crypto.randomUUID();
  const name = sanitizeName(payload.name) || `Игрок ${String(sessionId).slice(0, 4)}`;
  const session = {
    id: sessionId,
    name,
    color: colors[store.sessions.size % colors.length],
    lastSeen: Date.now()
  };
  store.sessions.set(sessionId, session);
  return session;
}

export function ensureSession(store, payload = {}) {
  const sessionId = sanitizeId(payload.sessionId);
  if (sessionId && store.sessions.has(sessionId)) {
    const session = store.sessions.get(sessionId);
    session.name = sanitizeName(payload.name) || session.name;
    session.lastSeen = Date.now();
    return session;
  }
  return createSession(store, payload);
}

export function createBattle(store, ownerSession, payload = {}) {
  const battle = {
    id: crypto.randomBytes(3).toString("hex").toUpperCase(),
    name: sanitizeBattleName(payload.name) || `${ownerSession.name}: бой`,
    maxPlayers: clamp(Number(payload.maxPlayers) || 8, 2, 12),
    createdAt: Date.now(),
    players: new Map(),
    bullets: [],
    lastTick: Date.now()
  };
  store.battles.set(battle.id, battle);
  return battle;
}

export function addPlayerToBattle(battle, socketId, session) {
  if (battle.players.size >= battle.maxPlayers && !battle.players.has(socketId)) {
    return { ok: false, error: "Бой заполнен" };
  }

  const spawn = getSpawnPoint(battle.players.size);
  battle.players.set(socketId, {
    socketId,
    sessionId: session.id,
    name: session.name,
    color: session.color,
    x: spawn.x,
    z: spawn.z,
    angle: spawn.angle,
    turretAngle: spawn.angle,
    hp: 100,
    kills: 0,
    deaths: 0,
    input: emptyInput(),
    lastFireAt: 0,
    respawnAt: 0
  });

  return { ok: true };
}

export function removePlayerFromBattle(store, battleId, socketId) {
  if (!battleId || !store.battles.has(battleId)) {
    return;
  }

  const battle = store.battles.get(battleId);
  battle.players.delete(socketId);
  battle.bullets = battle.bullets.filter((bullet) => bullet.ownerSocketId !== socketId);

  if (battle.players.size === 0) {
    battle.emptySince = battle.emptySince || Date.now();
  }
}

export function updatePlayerInput(battle, socketId, payload = {}) {
  const player = battle?.players.get(socketId);
  if (!player) {
    return;
  }

  player.input = {
    up: Boolean(payload.up),
    down: Boolean(payload.down),
    left: Boolean(payload.left),
    right: Boolean(payload.right)
  };

  if (Number.isFinite(payload.aimAngle)) {
    player.turretAngle = normalizeAngle(payload.aimAngle);
  }
}

export function fireBullet(battle, socketId) {
  const player = battle?.players.get(socketId);
  if (!player || player.hp <= 0) {
    return false;
  }

  const now = Date.now();
  if (now - player.lastFireAt < FIRE_COOLDOWN_MS) {
    return false;
  }

  const ownBullets = battle.bullets.filter((bullet) => bullet.ownerSocketId === socketId).length;
  if (ownBullets >= WORLD.maxBulletsPerPlayer) {
    return false;
  }

  player.lastFireAt = now;
  const dx = Math.sin(player.turretAngle);
  const dz = Math.cos(player.turretAngle);

  battle.bullets.push({
    id: crypto.randomBytes(4).toString("hex"),
    ownerSocketId: socketId,
    ownerName: player.name,
    x: player.x + dx * 2.4,
    z: player.z + dz * 2.4,
    vx: dx * BULLET_SPEED,
    vz: dz * BULLET_SPEED,
    ttl: BULLET_TTL
  });

  return true;
}

export function tickBattle(battle, now = Date.now()) {
  const dt = Math.min((now - battle.lastTick) / 1000, 0.08);
  battle.lastTick = now;

  for (const player of battle.players.values()) {
    updatePlayer(player, battle, dt, now);
  }

  const survivors = [];
  for (const bullet of battle.bullets) {
    bullet.ttl -= dt;
    bullet.x += bullet.vx * dt;
    bullet.z += bullet.vz * dt;

    if (bullet.ttl <= 0 || outOfBounds(bullet.x, bullet.z) || collidesWithObstacle(bullet.x, bullet.z, BULLET_RADIUS)) {
      continue;
    }

    const hit = findBulletHit(battle, bullet);
    if (hit) {
      hit.hp -= 34;
      if (hit.hp <= 0) {
        hit.hp = 0;
        hit.deaths += 1;
        hit.respawnAt = now + RESPAWN_MS;
        const owner = battle.players.get(bullet.ownerSocketId);
        if (owner && owner.socketId !== hit.socketId) {
          owner.kills += 1;
        }
      }
      continue;
    }

    survivors.push(bullet);
  }
  battle.bullets = survivors;
}

export function serializeBattleState(battle) {
  return {
    id: battle.id,
    name: battle.name,
    world: WORLD,
    players: [...battle.players.values()].map((player) => ({
      socketId: player.socketId,
      sessionId: player.sessionId,
      name: player.name,
      color: player.color,
      x: round(player.x),
      z: round(player.z),
      angle: round(player.angle),
      turretAngle: round(player.turretAngle),
      hp: player.hp,
      kills: player.kills,
      deaths: player.deaths,
      alive: player.hp > 0
    })),
    bullets: battle.bullets.map((bullet) => ({
      id: bullet.id,
      x: round(bullet.x),
      z: round(bullet.z)
    }))
  };
}

function updatePlayer(player, battle, dt, now) {
  if (player.hp <= 0) {
    if (player.respawnAt && now >= player.respawnAt) {
      const spawn = getSpawnPoint(Math.floor(Math.random() * 8));
      player.x = spawn.x;
      player.z = spawn.z;
      player.angle = spawn.angle;
      player.turretAngle = spawn.angle;
      player.hp = 100;
      player.respawnAt = 0;
    }
    return;
  }

  const turn = Number(player.input.left) - Number(player.input.right);
  player.angle = normalizeAngle(player.angle + turn * TURN_RATE * dt);

  const throttle = Number(player.input.up) - Number(player.input.down);
  if (throttle === 0) {
    return;
  }

  const nextX = player.x + Math.sin(player.angle) * PLAYER_SPEED * throttle * dt;
  const nextZ = player.z + Math.cos(player.angle) * PLAYER_SPEED * throttle * dt;

  if (!outOfBounds(nextX, player.z) && !collidesWithObstacle(nextX, player.z, PLAYER_RADIUS)) {
    player.x = nextX;
  }
  if (!outOfBounds(player.x, nextZ) && !collidesWithObstacle(player.x, nextZ, PLAYER_RADIUS)) {
    player.z = nextZ;
  }
}

function findBulletHit(battle, bullet) {
  for (const player of battle.players.values()) {
    if (player.socketId === bullet.ownerSocketId || player.hp <= 0) {
      continue;
    }

    const dx = player.x - bullet.x;
    const dz = player.z - bullet.z;
    if (Math.hypot(dx, dz) < PLAYER_RADIUS + BULLET_RADIUS) {
      return player;
    }
  }
  return null;
}

function getSpawnPoint(index) {
  const points = [
    { x: -40, z: -24, angle: Math.PI / 4 },
    { x: 40, z: 24, angle: -Math.PI * 0.75 },
    { x: -40, z: 24, angle: Math.PI * 0.75 },
    { x: 40, z: -24, angle: -Math.PI / 4 },
    { x: 0, z: -28, angle: 0 },
    { x: 0, z: 28, angle: Math.PI },
    { x: -44, z: 0, angle: Math.PI / 2 },
    { x: 44, z: 0, angle: -Math.PI / 2 }
  ];
  return points[index % points.length];
}

function collidesWithObstacle(x, z, radius) {
  return WORLD.obstacles.some((box) => (
    x + radius > box.x - box.w / 2 &&
    x - radius < box.x + box.w / 2 &&
    z + radius > box.z - box.d / 2 &&
    z - radius < box.z + box.d / 2
  ));
}

function outOfBounds(x, z) {
  return Math.abs(x) > WORLD.width / 2 - PLAYER_RADIUS || Math.abs(z) > WORLD.depth / 2 - PLAYER_RADIUS;
}

function emptyInput() {
  return { up: false, down: false, left: false, right: false };
}

function sanitizeId(value) {
  return typeof value === "string" && value.length < 128 ? value : "";
}

function sanitizeName(value) {
  return typeof value === "string" ? value.trim().slice(0, 20) : "";
}

function sanitizeBattleName(value) {
  return typeof value === "string" ? value.trim().slice(0, 32) : "";
}

function clamp(value, min, max) {
  return Math.min(Math.max(value, min), max);
}

function normalizeAngle(value) {
  let angle = value;
  while (angle > Math.PI) angle -= Math.PI * 2;
  while (angle < -Math.PI) angle += Math.PI * 2;
  return angle;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

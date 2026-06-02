import "./styles.css";
import { io } from "socket.io-client";
import * as THREE from "three";

const socket = io();
const app = document.querySelector("#app");
const storageKey = "tank-arena-session";

const state = {
  session: loadSession(),
  connected: false,
  battles: [],
  battle: null,
  menuOpen: false,
  selfSocketId: null,
  world: null,
  players: new Map(),
  bullets: new Map(),
  keys: { up: false, down: false, left: false, right: false },
  aimAngle: 0,
  lastInputSentAt: 0
};

app.innerHTML = `
  <canvas id="arena"></canvas>
  <main class="hud">
    <button class="menu-button" id="menuButton" type="button" aria-controls="lobbyPanel" aria-expanded="false">Меню</button>
    <section class="sidebar" id="lobbyPanel" data-testid="lobby-panel">
      <div class="brand">
        <div>
          <h1>Tank Arena</h1>
          <p id="connection">Подключение...</p>
        </div>
        <button class="icon-button" id="leaveButton" title="Выйти из боя" aria-label="Выйти из боя">↩</button>
      </div>

      <label class="field">
        <span>Позывной</span>
        <input id="playerName" maxlength="20" autocomplete="off" />
      </label>

      <form class="create" id="createForm">
        <label class="field">
          <span>Название боя</span>
          <input id="battleName" maxlength="32" placeholder="Быстрый бой" autocomplete="off" />
        </label>
        <label class="field">
          <span>Игроков</span>
          <input id="maxPlayers" type="number" min="2" max="12" value="8" />
        </label>
        <button type="submit">Создать бой</button>
      </form>

      <div class="section-title">
        <h2>Открытые бои</h2>
        <button id="refreshButton" class="text-button" type="button">Обновить</button>
      </div>
      <div id="battleList" class="battle-list"></div>
    </section>

    <section class="match-panel" data-testid="match-panel">
      <div class="score-line">
        <strong id="battleTitle">Лобби</strong>
        <span id="battleCode"></span>
      </div>
      <div id="roster" class="roster"></div>
      <div class="controls">
        <span>WASD / стрелки</span>
        <span>Мышь</span>
        <span>ЛКМ / Space</span>
      </div>
    </section>
  </main>
`;

const canvas = document.querySelector("#arena");
const hud = document.querySelector(".hud");
const menuButton = document.querySelector("#menuButton");
const connection = document.querySelector("#connection");
const playerName = document.querySelector("#playerName");
const createForm = document.querySelector("#createForm");
const createButton = createForm.querySelector("button[type='submit']");
const battleName = document.querySelector("#battleName");
const maxPlayers = document.querySelector("#maxPlayers");
const battleList = document.querySelector("#battleList");
const refreshButton = document.querySelector("#refreshButton");
const leaveButton = document.querySelector("#leaveButton");
const battleTitle = document.querySelector("#battleTitle");
const battleCode = document.querySelector("#battleCode");
const roster = document.querySelector("#roster");

playerName.value = state.session.name;
syncConnectionControls();
syncHud();

const renderer = new THREE.WebGLRenderer({ canvas, antialias: true, preserveDrawingBuffer: true });
renderer.setPixelRatio(Math.min(window.devicePixelRatio, 2));
renderer.shadowMap.enabled = true;
renderer.setClearColor(0x101418);

const keyBindingsByCode = {
  KeyW: "up",
  ArrowUp: "up",
  KeyS: "down",
  ArrowDown: "down",
  KeyA: "left",
  ArrowLeft: "left",
  KeyD: "right",
  ArrowRight: "right"
};

const keyBindingsByKey = {
  w: "up",
  arrowup: "up",
  s: "down",
  arrowdown: "down",
  a: "left",
  arrowleft: "left",
  d: "right",
  arrowright: "right"
};

const scene = new THREE.Scene();
scene.fog = new THREE.Fog(0x101418, 72, 122);

const camera = new THREE.PerspectiveCamera(50, 1, 0.1, 240);
camera.position.set(0, 58, 44);
camera.lookAt(0, 0, 0);

const raycaster = new THREE.Raycaster();
const pointer = new THREE.Vector2();
const groundPlane = new THREE.Plane(new THREE.Vector3(0, 1, 0), 0);
const pointerHit = new THREE.Vector3();
const meshes = {
  players: new Map(),
  bullets: new Map(),
  obstacles: new Map()
};

setupScene();
resize();
requestAnimationFrame(render);

socket.on("connect", () => {
  state.connected = true;
  syncConnectionControls();
  hello();
});

socket.on("disconnect", () => {
  state.connected = false;
  connection.textContent = "Нет соединения";
  syncConnectionControls();
});

socket.on("connect_error", () => {
  state.connected = false;
  connection.textContent = "Нет соединения с сервером";
  syncConnectionControls();
});

socket.on("battles:update", (battles) => {
  state.battles = battles;
  renderBattles();
});

socket.on("world:state", (snapshot) => {
  applyWorldState(snapshot);
});

playerName.addEventListener("change", () => {
  state.session.name = cleanName(playerName.value) || state.session.name;
  saveSession(state.session);
  hello();
});

createForm.addEventListener("submit", (event) => {
  event.preventDefault();

  if (!state.connected) {
    connection.textContent = "Нет соединения с сервером";
    return;
  }

  createButton.disabled = true;
  connection.textContent = "Создание боя...";
  socket.timeout(5000).emit("battle:create", {
    name: battleName.value,
    maxPlayers: Number(maxPlayers.value)
  }, (error, reply) => {
    createButton.disabled = !state.connected;
    if (error) {
      connection.textContent = "Сервер не ответил";
      return;
    }

    handleJoinReply(reply);
  });
});

refreshButton.addEventListener("click", requestBattles);
menuButton.addEventListener("click", () => {
  state.menuOpen = !state.menuOpen;
  syncHud();
});
leaveButton.addEventListener("click", () => {
  socket.emit("battle:leave", () => {
    state.battle = null;
    state.menuOpen = false;
    state.selfSocketId = null;
    state.players.clear();
    state.bullets.clear();
    syncMeshes();
    syncHud();
    renderMatchPanel();
    requestBattles();
  });
});

window.addEventListener("resize", resize);
window.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && state.battle && state.menuOpen) {
    state.menuOpen = false;
    syncHud();
  }
});
window.addEventListener("keydown", (event) => updateKey(event, true));
window.addEventListener("keyup", (event) => updateKey(event, false));
window.addEventListener("pointermove", updateAim);
window.addEventListener("pointerdown", (event) => {
  if (event.button === 0 && state.battle) {
    socket.emit("player:fire");
  }
});

function hello() {
  connection.textContent = "Подключение сессии...";
  socket.emit("session:hello", state.session, (reply) => {
    if (!reply?.ok) {
      connection.textContent = "Ошибка сессии";
      return;
    }

    state.session = reply.session;
    playerName.value = state.session.name;
    saveSession(state.session);
    connection.textContent = `Сессия ${state.session.id.slice(0, 8)}`;
    requestBattles();
  });
}

function requestBattles() {
  socket.emit("battle:list", (reply) => {
    if (reply?.ok) {
      state.battles = reply.battles;
      renderBattles();
    }
  });
}

function handleJoinReply(reply) {
  if (!reply?.ok) {
    connection.textContent = reply?.error || "Не удалось войти в бой";
    return;
  }

  state.battle = reply.battle;
  state.menuOpen = false;
  state.selfSocketId = reply.selfSocketId;
  applyWorldState(reply.state);
  syncHud();
  renderMatchPanel();
}

function syncConnectionControls() {
  createButton.disabled = !state.connected;
}

function syncHud() {
  const inBattle = Boolean(state.battle);
  hud.classList.toggle("in-battle", inBattle);
  hud.classList.toggle("menu-open", !inBattle || state.menuOpen);
  menuButton.hidden = !inBattle;
  menuButton.setAttribute("aria-expanded", String(inBattle && state.menuOpen));
}

function renderBattles() {
  battleList.replaceChildren();

  if (state.battles.length === 0) {
    const empty = document.createElement("p");
    empty.className = "empty";
    empty.textContent = "Пока нет активных боёв";
    battleList.append(empty);
    return;
  }

  for (const battle of state.battles) {
    const item = document.createElement("button");
    item.type = "button";
    item.className = "battle-card";
    item.disabled = battle.status === "full";
    item.innerHTML = `
      <span>
        <strong>${escapeHtml(battle.name)}</strong>
        <small>${battle.id}</small>
      </span>
      <span class="pill">${battle.playerCount}/${battle.maxPlayers}</span>
    `;
    item.addEventListener("click", () => {
      socket.emit("battle:join", { battleId: battle.id }, handleJoinReply);
    });
    battleList.append(item);
  }
}

function renderMatchPanel() {
  battleTitle.textContent = state.battle?.name || "Лобби";
  battleCode.textContent = state.battle ? `Код ${state.battle.id}` : "";
  roster.replaceChildren();

  const players = [...state.players.values()].sort((a, b) => b.kills - a.kills);
  for (const player of players) {
    const row = document.createElement("div");
    row.className = `roster-row ${player.socketId === state.selfSocketId ? "self" : ""}`;
    row.innerHTML = `
      <span class="dot" style="background:#${player.color.toString(16).padStart(6, "0")}"></span>
      <strong>${escapeHtml(player.name)}</strong>
      <span>${player.kills}/${player.deaths}</span>
      <meter min="0" max="100" value="${player.hp}"></meter>
    `;
    roster.append(row);
  }
}

function applyWorldState(snapshot) {
  state.world = snapshot.world;
  state.battle = state.battle || { id: snapshot.id, name: snapshot.name };
  state.players = new Map(snapshot.players.map((player) => [player.socketId, player]));
  state.bullets = new Map(snapshot.bullets.map((bullet) => [bullet.id, bullet]));
  syncObstacles(snapshot.world.obstacles);
  syncMeshes();
  renderMatchPanel();
}

function syncMeshes() {
  for (const [socketId, mesh] of meshes.players) {
    if (!state.players.has(socketId)) {
      scene.remove(mesh);
      meshes.players.delete(socketId);
    }
  }

  for (const player of state.players.values()) {
    let tank = meshes.players.get(player.socketId);
    if (!tank) {
      tank = createTank(player.color);
      meshes.players.set(player.socketId, tank);
      scene.add(tank);
    }

    tank.position.set(player.x, 0.6, player.z);
    tank.rotation.y = player.angle;
    tank.userData.turret.rotation.y = player.turretAngle - player.angle;
    tank.userData.hpBar.scale.x = Math.max(player.hp, 0) / 100;
    tank.visible = player.alive;
  }

  for (const [id, mesh] of meshes.bullets) {
    if (!state.bullets.has(id)) {
      scene.remove(mesh);
      meshes.bullets.delete(id);
    }
  }

  for (const bullet of state.bullets.values()) {
    let mesh = meshes.bullets.get(bullet.id);
    if (!mesh) {
      mesh = createBullet();
      meshes.bullets.set(bullet.id, mesh);
      scene.add(mesh);
    }
    mesh.position.set(bullet.x, 0.75, bullet.z);
  }
}

function syncObstacles(obstacles = []) {
  for (const obstacle of obstacles) {
    if (meshes.obstacles.has(obstacle.id)) {
      continue;
    }
    const mesh = new THREE.Mesh(
      new THREE.BoxGeometry(obstacle.w, 2.3, obstacle.d),
      new THREE.MeshStandardMaterial({ color: 0x4a5259, roughness: 0.9 })
    );
    mesh.castShadow = true;
    mesh.receiveShadow = true;
    mesh.position.set(obstacle.x, 1.15, obstacle.z);
    meshes.obstacles.set(obstacle.id, mesh);
    scene.add(mesh);
  }
}

function setupScene() {
  const ambient = new THREE.HemisphereLight(0xeaf6ff, 0x26312b, 1.8);
  scene.add(ambient);

  const sun = new THREE.DirectionalLight(0xffffff, 2.2);
  sun.position.set(-22, 46, 28);
  sun.castShadow = true;
  sun.shadow.mapSize.set(2048, 2048);
  scene.add(sun);

  const floor = new THREE.Mesh(
    new THREE.PlaneGeometry(120, 88, 24, 18),
    new THREE.MeshStandardMaterial({ color: 0x232b28, roughness: 0.95, metalness: 0.02 })
  );
  floor.rotation.x = -Math.PI / 2;
  floor.receiveShadow = true;
  scene.add(floor);

  const grid = new THREE.GridHelper(120, 24, 0x52615b, 0x303a36);
  grid.position.y = 0.02;
  scene.add(grid);

  const boundary = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(96, 0.2, 64)),
    new THREE.LineBasicMaterial({ color: 0x8aa39a })
  );
  boundary.position.y = 0.08;
  scene.add(boundary);
}

function createTank(color) {
  const group = new THREE.Group();
  const bodyMaterial = new THREE.MeshStandardMaterial({ color, roughness: 0.52, metalness: 0.12 });
  const darkMaterial = new THREE.MeshStandardMaterial({ color: 0x1d2424, roughness: 0.8 });

  const body = new THREE.Mesh(new THREE.BoxGeometry(2.7, 1.1, 3.8), bodyMaterial);
  body.castShadow = true;
  body.receiveShadow = true;
  group.add(body);

  const leftTrack = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.55, 4.1), darkMaterial);
  leftTrack.position.set(-1.55, -0.15, 0);
  leftTrack.castShadow = true;
  group.add(leftTrack);

  const rightTrack = leftTrack.clone();
  rightTrack.position.x = 1.55;
  group.add(rightTrack);

  const turret = new THREE.Group();
  const dome = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.05, 0.7, 18), bodyMaterial);
  dome.position.y = 0.75;
  dome.castShadow = true;
  turret.add(dome);

  const barrel = new THREE.Mesh(new THREE.BoxGeometry(0.38, 0.34, 2.8), darkMaterial);
  barrel.position.set(0, 0.82, 1.7);
  barrel.castShadow = true;
  turret.add(barrel);
  group.add(turret);

  const hpBg = new THREE.Mesh(new THREE.BoxGeometry(3.4, 0.12, 0.12), new THREE.MeshBasicMaterial({ color: 0x111111 }));
  hpBg.position.set(0, 2.1, -0.35);
  group.add(hpBg);

  const hpBar = new THREE.Mesh(new THREE.BoxGeometry(3.2, 0.14, 0.14), new THREE.MeshBasicMaterial({ color: 0x68e37d }));
  hpBar.position.set(0, 2.12, -0.35);
  group.add(hpBar);

  group.userData.turret = turret;
  group.userData.hpBar = hpBar;
  return group;
}

function createBullet() {
  const mesh = new THREE.Mesh(
    new THREE.SphereGeometry(0.35, 14, 10),
    new THREE.MeshStandardMaterial({ color: 0xfff0a8, emissive: 0xffb84d, emissiveIntensity: 1.6 })
  );
  mesh.castShadow = true;
  return mesh;
}

function render() {
  sendInput();
  followCamera();
  renderer.render(scene, camera);
  requestAnimationFrame(render);
}

function followCamera() {
  const self = state.players.get(state.selfSocketId);
  const target = self ? new THREE.Vector3(self.x, 0, self.z) : new THREE.Vector3(0, 0, 0);
  camera.position.lerp(new THREE.Vector3(target.x, 58, target.z + 44), 0.07);
  camera.lookAt(target.x, 0, target.z);
}

function sendInput(force = false) {
  if (!state.battle || !state.connected) {
    return;
  }

  const now = performance.now();
  if (!force && now - state.lastInputSentAt < 33) {
    return;
  }

  state.lastInputSentAt = now;
  socket.emit("input:update", { ...state.keys, aimAngle: state.aimAngle });
}

function updateKey(event, pressed) {
  if (isTextInput(event.target)) {
    return;
  }

  const key = event.key.toLowerCase();
  const binding = keyBindingsByCode[event.code] || keyBindingsByKey[key];
  if (binding) {
    event.preventDefault();
    state.keys[binding] = pressed;
    sendInput(true);
  }

  if (pressed && (event.code === "Space" || key === " ")) {
    event.preventDefault();
    socket.emit("player:fire");
  }
}

function isTextInput(target) {
  return target instanceof HTMLInputElement || target instanceof HTMLTextAreaElement || target?.isContentEditable;
}

function updateAim(event) {
  pointer.x = (event.clientX / window.innerWidth) * 2 - 1;
  pointer.y = -(event.clientY / window.innerHeight) * 2 + 1;
  raycaster.setFromCamera(pointer, camera);
  raycaster.ray.intersectPlane(groundPlane, pointerHit);

  const self = state.players.get(state.selfSocketId);
  if (!self) {
    return;
  }

  state.aimAngle = Math.atan2(pointerHit.x - self.x, pointerHit.z - self.z);
}

function resize() {
  const width = window.innerWidth;
  const height = window.innerHeight;
  renderer.setSize(width, height, false);
  camera.aspect = width / height;
  camera.updateProjectionMatrix();
}

function loadSession() {
  try {
    const saved = JSON.parse(localStorage.getItem(storageKey));
    if (saved?.id) return saved;
  } catch {
    // Local storage can be unavailable in private browser modes.
  }
  return {
    id: createId(),
    name: `Танкист ${Math.floor(1000 + Math.random() * 9000)}`
  };
}

function createId() {
  if (globalThis.crypto?.randomUUID) return globalThis.crypto.randomUUID();
  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) bytes[index] = Math.floor(Math.random() * 256);
  }
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0"));
  return `${hex.slice(0, 4).join("")}-${hex.slice(4, 6).join("")}-${hex.slice(6, 8).join("")}-${hex.slice(8, 10).join("")}-${hex.slice(10).join("")}`;
}

function saveSession(session) {
  localStorage.setItem(storageKey, JSON.stringify(session));
}

function cleanName(value) {
  return String(value || "").trim().slice(0, 20);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

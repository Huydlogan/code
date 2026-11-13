// ============================================================
//  SERVER GAME 3D ONLINE - chạy trên Cloudflare
//  - Worker: nhận yêu cầu. "/ws" chuyển tới phòng game, còn lại là file trong public/
//  - GameRoom (Durable Object): MỘT bản duy nhất tên "world" = một server game.
//    Nó giữ trạng thái thật của game (vị trí mọi người chơi), nhận phím bấm
//    từ client, tự tính vị trí rồi gửi lại cho tất cả.
// ============================================================
import { DurableObject } from 'cloudflare:workers';

// ---------- Thông số game ----------
const TICK_RATE = 30;        // server cập nhật 30 lần / giây
const MAP_HALF = 40;         // bản đồ rộng từ -40 đến +40
const PLAYER_SPEED = 8;      // tốc độ đi bộ (đơn vị / giây)
const RUN_SPEED = 14;        // tốc độ khi giữ Shift
const JUMP_SPEED = 9;        // vận tốc bật lên khi nhảy
const GRAVITY = 25;          // trọng lực kéo xuống
const CHAT_RADIUS = 6;       // chỉ người đứng trong khoảng cách này mới nghe được
const CHAT_MAX_LENGTH = 100; // số ký tự tối đa của một câu chat
const CHAT_COOLDOWN_MS = 500; // mỗi người chỉ được gửi 1 câu / 0.5 giây
const PLAYER_RADIUS = 0.6;   // bán kính va chạm của nhân vật
const MAX_PLAYERS = 50;
const MAX_MESSAGE_LENGTH = 1024; // tin nhắn dài hơn mức này bị bỏ qua

// Vật cản trên bản đồ: x, z là tâm; w, d là chiều rộng và chiều sâu; h là chiều cao
const OBSTACLES = [
  { x: 0, z: -10, w: 6, d: 2, h: 3 },
  { x: -12, z: 5, w: 3, d: 3, h: 5 },
  { x: 14, z: 8, w: 2, d: 10, h: 2 },
  { x: -20, z: -18, w: 8, d: 3, h: 4 },
  { x: 22, z: -15, w: 4, d: 4, h: 6 },
  { x: 5, z: 20, w: 10, d: 2, h: 2.5 },
  { x: -25, z: 22, w: 3, d: 8, h: 3 },
  { x: 28, z: 26, w: 5, d: 5, h: 4 },
];

const COLORS = [0xe74c3c, 0x3498db, 0x2ecc71, 0xf1c40f, 0x9b59b6, 0xe67e22, 0x1abc9c, 0xff6fb5];

// ---------- Hàm tiện ích ----------

// Kiểm tra hình tròn (nhân vật) có chạm hình chữ nhật (vật cản) không
function hitsObstacle(x, z) {
  for (const o of OBSTACLES) {
    const nearestX = Math.max(o.x - o.w / 2, Math.min(x, o.x + o.w / 2));
    const nearestZ = Math.max(o.z - o.d / 2, Math.min(z, o.z + o.d / 2));
    const distX = x - nearestX;
    const distZ = z - nearestZ;
    if (distX * distX + distZ * distZ < PLAYER_RADIUS * PLAYER_RADIUS) return true;
  }
  return false;
}

function randomSpawn() {
  for (let i = 0; i < 100; i++) {
    const x = (Math.random() * 2 - 1) * 15;
    const z = (Math.random() * 2 - 1) * 15;
    if (!hitsObstacle(x, z)) return { x, z };
  }
  return { x: 0, z: 0 };
}

function clamp(v, min, max) {
  return Math.max(min, Math.min(max, v));
}

// Thông tin công khai của một người chơi (gửi cho client)
function publicInfo(p) {
  return { id: p.id, name: p.name, color: p.color, x: p.x, y: p.y, z: p.z, rot: p.rot };
}

function send(ws, msg) {
  try {
    ws.send(typeof msg === 'string' ? msg : JSON.stringify(msg));
  } catch {
    // kết nối đã đóng: bỏ qua, sự kiện "close" sẽ dọn người chơi này
  }
}

// ============================================================
//  1. PHÒNG GAME (Durable Object)
// ============================================================
export class GameRoom extends DurableObject {
  constructor(ctx, env) {
    super(ctx, env);
    this.players = new Map(); // id -> { id, name, color, x, y, z, rot, dx, dz, run, jump, ws, ... }
    this.nextId = 1;
    this.timer = null; // vòng lặp game, chỉ chạy khi có người chơi
  }

  // Mỗi người chơi mở một kết nối WebSocket tới đây
  async fetch(request) {
    if (request.headers.get('Upgrade') !== 'websocket') {
      return new Response('Cần kết nối WebSocket', { status: 426 });
    }
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    server.accept();
    this.handleSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  broadcast(msg, exceptId) {
    const text = JSON.stringify(msg);
    for (const p of this.players.values()) {
      if (p.id !== exceptId) send(p.ws, text);
    }
  }

  handleSocket(ws) {
    let player = null; // chưa "vào game" cho đến khi gửi tên

    ws.addEventListener('message', (event) => {
      if (typeof event.data !== 'string' || event.data.length > MAX_MESSAGE_LENGTH) return;
      let msg;
      try {
        msg = JSON.parse(event.data);
      } catch {
        return; // bỏ qua dữ liệu rác
      }
      if (!msg || typeof msg !== 'object') return;

      // --- Người chơi xin vào game ---
      if (msg.type === 'join' && !player) {
        if (this.players.size >= MAX_PLAYERS) {
          send(ws, { type: 'error', message: 'Server đã đầy.' });
          ws.close(1000, 'full');
          return;
        }
        const name = String(msg.name || '').trim().slice(0, 16) || 'Người chơi';
        const spawn = randomSpawn();
        const id = this.nextId++;
        player = {
          id,
          name,
          color: COLORS[id % COLORS.length],
          x: spawn.x,
          y: 0,          // độ cao (0 = đang đứng trên mặt đất)
          vy: 0,         // vận tốc theo chiều dọc
          z: spawn.z,
          rot: 0,
          dx: 0,
          dz: 0,
          run: false,    // đang giữ Shift
          jump: false,   // đang giữ Space
          lastChat: 0,
          ws,
        };
        this.players.set(id, player);

        // Gửi cho người mới: id của họ, bản đồ, và danh sách người đang online
        send(ws, {
          type: 'init',
          id,
          map: { half: MAP_HALF, obstacles: OBSTACLES, chatRadius: CHAT_RADIUS },
          players: [...this.players.values()].map(publicInfo),
        });
        // Báo cho những người còn lại
        this.broadcast({ type: 'joined', player: publicInfo(player) }, id);
        this.startLoop();
        return;
      }

      // --- Người chơi gửi hướng di chuyển ---
      // Client CHỈ gửi "tôi muốn đi hướng nào", KHÔNG gửi vị trí.
      // Server tự tính vị trí, nên không thể gian lận dịch chuyển tức thời.
      if (msg.type === 'input' && player) {
        const dx = Number(msg.dx);
        const dz = Number(msg.dz);
        player.dx = Number.isFinite(dx) ? clamp(dx, -1, 1) : 0;
        player.dz = Number.isFinite(dz) ? clamp(dz, -1, 1) : 0;
        player.run = msg.run === true;
        player.jump = msg.jump === true;
        return;
      }

      // --- Người chơi gửi tin nhắn ---
      // Server chỉ chuyển tin cho những người đang đứng gần người nói.
      if (msg.type === 'chat' && player) {
        const now = Date.now();
        if (now - player.lastChat < CHAT_COOLDOWN_MS) return; // chống spam
        const text = String(msg.text || '').replace(/\s+/g, ' ').trim().slice(0, CHAT_MAX_LENGTH);
        if (!text) return;
        player.lastChat = now;

        const out = JSON.stringify({ type: 'chat', id: player.id, text });
        for (const other of this.players.values()) {
          const dist = Math.hypot(other.x - player.x, other.z - player.z);
          if (dist <= CHAT_RADIUS) send(other.ws, out);
        }
      }
    });

    const leave = () => {
      if (!player) return;
      const id = player.id;
      player = null;
      this.players.delete(id);
      this.broadcast({ type: 'left', id });
      if (this.players.size === 0) this.stopLoop();
      try {
        ws.close(1000, 'bye');
      } catch {
        // đã đóng rồi
      }
    };
    ws.addEventListener('close', leave);
    ws.addEventListener('error', leave);
  }

  // ---------- Vòng lặp game ----------
  // Chỉ chạy khi có người chơi. Không còn ai thì dừng để server "ngủ",
  // không tốn hạn mức miễn phí của Cloudflare.
  startLoop() {
    if (this.timer !== null) return;
    this.lastTick = Date.now();
    this.timer = setInterval(() => this.tick(), 1000 / TICK_RATE);
  }

  stopLoop() {
    if (this.timer === null) return;
    clearInterval(this.timer);
    this.timer = null;
  }

  tick() {
    // Đo thời gian thật giữa hai lần cập nhật: đồng hồ hẹn giờ không đều tuyệt đối,
    // nếu giả định đúng 1/30 giây thì nhân vật sẽ đi chậm hơn tốc độ đã đặt.
    const now = Date.now();
    const DT = clamp((now - this.lastTick) / 1000, 0, 0.1);
    this.lastTick = now;

    for (const p of this.players.values()) {
      // --- Nhảy và rơi ---
      if (p.jump && p.y === 0) p.vy = JUMP_SPEED; // chỉ nhảy được khi đang đứng trên đất
      if (p.y > 0 || p.vy > 0) {
        p.vy -= GRAVITY * DT;
        p.y += p.vy * DT;
        if (p.y <= 0) {
          p.y = 0;
          p.vy = 0;
        }
      }

      // --- Di chuyển ngang ---
      let { dx, dz } = p;
      const len = Math.hypot(dx, dz);
      // Trạng thái di chuyển để client chọn hoạt ảnh: 0 đứng yên, 1 đi, 2 chạy
      p.move = len < 0.01 ? 0 : p.run ? 2 : 1;
      if (len < 0.01) continue;

      // Chuẩn hóa để đi chéo không nhanh hơn đi thẳng
      if (len > 1) {
        dx /= len;
        dz /= len;
      }

      const speed = p.run ? RUN_SPEED : PLAYER_SPEED;

      // Di chuyển từng trục riêng để nhân vật trượt dọc theo tường
      const newX = clamp(p.x + dx * speed * DT, -MAP_HALF + PLAYER_RADIUS, MAP_HALF - PLAYER_RADIUS);
      if (!hitsObstacle(newX, p.z)) p.x = newX;

      const newZ = clamp(p.z + dz * speed * DT, -MAP_HALF + PLAYER_RADIUS, MAP_HALF - PLAYER_RADIUS);
      if (!hitsObstacle(p.x, newZ)) p.z = newZ;

      p.rot = Math.atan2(dx, dz); // hướng nhân vật quay mặt
    }

    // Gửi vị trí mới của mọi người cho tất cả
    this.broadcast({
      type: 'state',
      players: [...this.players.values()].map((p) => ({
        id: p.id,
        x: Math.round(p.x * 100) / 100,
        y: Math.round(p.y * 100) / 100,
        z: Math.round(p.z * 100) / 100,
        rot: Math.round(p.rot * 100) / 100,
        m: p.move || 0,
      })),
    });
  }
}

// ============================================================
//  2. WORKER: cửa vào
//  File trong public/ do Cloudflare tự phát; chỉ những đường dẫn
//  không phải file mới chạy tới đây.
// ============================================================
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    if (url.pathname === '/ws') {
      // Mọi người đều vào cùng một phòng tên "world".
      // Sau này muốn nhiều server: đổi tên phòng theo đường dẫn, ví dụ /ws/phong-2
      const room = env.GAME_ROOM.get(env.GAME_ROOM.idFromName('world'));
      return room.fetch(request);
    }
    return new Response('Not found', { status: 404 });
  },
};

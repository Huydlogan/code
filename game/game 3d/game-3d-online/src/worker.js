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
const EMOTE_COOLDOWN_MS = 500; // mỗi người chỉ được làm 1 cử chỉ / 0.5 giây
// Các cử chỉ được phép (phải khớp với danh sách EMOTES trong public/index.html)
const EMOTES = ['dance', 'hello', 'bye', 'angry', 'sad', 'bored', 'laugh', 'cry'];

// ---------- Chiến đấu ----------
// Trạng thái hành động của nhân vật (gửi cho client trong trường "a")
const ACT = { NONE: 0, CHARGE: 1, DASH: 2, STAGGER: 3, DOWN: 4, GETUP: 5 };
const PUNCH_RANGE = 2.4;      // tầm với của cú đấm
const PUNCH_COMBO_MS = 500;   // bấm cú thứ hai trong khoảng này thì thành combo 2 cú
const PUNCH_MIN_GAP_MS = 120; // khoảng cách ngắn nhất giữa 2 cú của combo
const CHARGE_MAX_MS = 1500;   // gồng lâu hơn mức này cũng không mạnh thêm
const DASH_MIN = 3;           // quãng lướt khi gồng rất ngắn
const DASH_MAX = 12;          // quãng lướt khi gồng hết mức
const DASH_SPEED = 30;        // tốc độ lướt (đơn vị / giây)
const DASH_HIT_RADIUS = 1.5;  // lướt sượt qua ai trong khoảng này thì người đó bị hất ngã
const DOWN_MS = 1500;         // thời gian nằm dưới đất
const GETUP_MS = 700;         // thời gian đứng dậy
const KNOCK_FRICTION = 8;     // độ hãm khi bị đẩy lùi (lớn hơn thì dừng nhanh hơn)

const PLAYER_RADIUS = 0.6; // bán kính va chạm của nhân vật
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

// Dịch nhân vật đi một đoạn (mx, mz), có chặn tường và mép bản đồ.
// Đi từng trục riêng để nhân vật trượt dọc theo tường. Trả về true nếu có nhúc nhích.
function tryMove(p, mx, mz) {
  const limit = MAP_HALF - PLAYER_RADIUS;
  const oldX = p.x;
  const oldZ = p.z;
  const newX = clamp(p.x + mx, -limit, limit);
  if (!hitsObstacle(newX, p.z)) p.x = newX;
  const newZ = clamp(p.z + mz, -limit, limit);
  if (!hitsObstacle(p.x, newZ)) p.z = newZ;
  return Math.abs(p.x - oldX) + Math.abs(p.z - oldZ) > 1e-4;
}

// Làm choáng: lùi nhẹ theo hướng (dirX, dirZ), mất điều khiển một lúc
function stagger(p, dirX, dirZ, speed, ms, now) {
  p.act = ACT.STAGGER;
  p.actUntil = now + ms;
  p.kx = dirX * speed;
  p.kz = dirZ * speed;
}

// Hất ngã: văng đi, nằm một lúc rồi tự đứng dậy
function knockDown(p, dirX, dirZ, speed, now) {
  p.act = ACT.DOWN;
  p.actUntil = now + DOWN_MS;
  p.kx = dirX * speed;
  p.kz = dirZ * speed;
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
          lastEmote: 0,
          act: ACT.NONE, // đang gồng / lướt / choáng / nằm / đứng dậy
          actUntil: 0,   // thời điểm hết trạng thái choáng, nằm, đứng dậy
          kx: 0,         // vận tốc bị đẩy lùi
          kz: 0,
          lastPunch: 0,
          punchCount: 0, // 1 = cú đầu, 2 = cú thứ hai của combo
          chargeStart: 0,
          dashLeft: 0,   // quãng lướt còn lại
          dashPower: 0,  // 0..1, gồng càng lâu càng lớn
          dashHit: null, // những người đã trúng trong lần lướt này
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

      // --- Đấm về phía trước ---
      // Bấm một lần: 1 cú. Bấm tiếp ngay sau đó: cú thứ hai của combo.
      if (msg.type === 'punch' && player) {
        if (player.act !== ACT.NONE) return;
        const now = Date.now();
        const gap = now - player.lastPunch;
        if (gap > PUNCH_COMBO_MS) player.punchCount = 1;
        else if (player.punchCount === 1 && gap >= PUNCH_MIN_GAP_MS) player.punchCount = 2;
        else return; // đã đấm đủ 2 cú, phải nghỉ một nhịp
        player.lastPunch = now;
        this.broadcast({ type: 'punch', id: player.id, n: player.punchCount });

        // Ai đứng trong tầm và ở phía trước mặt thì trúng đòn
        const dirX = Math.sin(player.rot);
        const dirZ = Math.cos(player.rot);
        for (const o of this.players.values()) {
          if (o === player || o.act === ACT.DOWN || o.act === ACT.GETUP) continue;
          const ox = o.x - player.x;
          const oz = o.z - player.z;
          const dist = Math.hypot(ox, oz);
          if (dist > PUNCH_RANGE || Math.abs(o.y - player.y) > 1.5) continue;
          if (dist > 0.01 && (ox * dirX + oz * dirZ) / dist < 0.4) continue; // không ở phía trước
          // Đang choáng mà dính thêm cú nữa thì ngã; còn không thì choáng và lùi nhẹ
          if (o.act === ACT.STAGGER) knockDown(o, dirX, dirZ, 8, now);
          else stagger(o, dirX, dirZ, player.punchCount === 2 ? 7 : 5, player.punchCount === 2 ? 900 : 650, now);
        }
        return;
      }

      // --- Gồng lực (giữ chuột) rồi thả ra để lướt tới ---
      if (msg.type === 'charge' && player) {
        const now = Date.now();
        if (msg.on === true) {
          if (player.act !== ACT.NONE) return;
          player.act = ACT.CHARGE;
          player.chargeStart = now;
        } else if (player.act === ACT.CHARGE) {
          if (msg.cancel === true) {
            player.act = ACT.NONE;
            return;
          }
          // Server tự đo thời gian gồng, không tin con số client gửi
          player.dashPower = clamp((now - player.chargeStart) / CHARGE_MAX_MS, 0, 1);
          player.dashLeft = DASH_MIN + (DASH_MAX - DASH_MIN) * player.dashPower;
          player.dashHit = new Set();
          player.act = ACT.DASH;
        }
        return;
      }

      // --- Người chơi làm một cử chỉ (vẫy tay, nhảy múa...) ---
      // Server chỉ kiểm tra tên hợp lệ rồi báo cho mọi người; client lo phần diễn hoạt ảnh.
      if (msg.type === 'emote' && player) {
        const now = Date.now();
        if (player.act !== ACT.NONE) return; // đang đánh nhau hoặc bị ngã thì không làm cử chỉ
        if (now - player.lastEmote < EMOTE_COOLDOWN_MS) return; // chống spam
        if (!EMOTES.includes(msg.name)) return;
        player.lastEmote = now;
        this.broadcast({ type: 'emote', id: player.id, name: msg.name });
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
      // --- Hết giờ choáng / nằm / đứng dậy ---
      if (p.act === ACT.STAGGER && now >= p.actUntil) p.act = ACT.NONE;
      if (p.act === ACT.DOWN && now >= p.actUntil) {
        p.act = ACT.GETUP; // nằm đủ lâu thì tự đứng dậy
        p.actUntil = now + GETUP_MS;
      } else if (p.act === ACT.GETUP && now >= p.actUntil) {
        p.act = ACT.NONE;
      }

      // --- Bị đẩy lùi sau khi trúng đòn: trượt đi rồi chậm dần ---
      if (p.kx !== 0 || p.kz !== 0) {
        tryMove(p, p.kx * DT, p.kz * DT);
        const slow = Math.exp(-KNOCK_FRICTION * DT);
        p.kx *= slow;
        p.kz *= slow;
        if (Math.hypot(p.kx, p.kz) < 0.3) p.kx = p.kz = 0;
      }

      // --- Nhảy và rơi ---
      if (p.jump && p.y === 0 && p.act === ACT.NONE) p.vy = JUMP_SPEED; // chỉ nhảy được khi đang đứng trên đất
      if (p.y > 0 || p.vy > 0) {
        p.vy -= GRAVITY * DT;
        p.y += p.vy * DT;
        if (p.y <= 0) {
          p.y = 0;
          p.vy = 0;
        }
      }

      let { dx, dz } = p;
      const len = Math.hypot(dx, dz);
      p.move = 0; // 0 đứng yên, 1 đi, 2 chạy (để client chọn hoạt ảnh)

      // --- Đang lướt tới sau khi gồng lực ---
      if (p.act === ACT.DASH) {
        const dirX = Math.sin(p.rot);
        const dirZ = Math.cos(p.rot);
        const step = Math.min(DASH_SPEED * DT, p.dashLeft);
        const moved = tryMove(p, dirX * step, dirZ * step);
        p.dashLeft -= step;

        // Ai đứng trên đường lướt thì bị hất ngã (mỗi người chỉ trúng một lần)
        for (const o of this.players.values()) {
          if (o === p || p.dashHit.has(o.id) || o.act === ACT.DOWN || o.act === ACT.GETUP) continue;
          if (Math.hypot(o.x - p.x, o.z - p.z) > DASH_HIT_RADIUS || Math.abs(o.y - p.y) > 1.5) continue;
          p.dashHit.add(o.id);
          knockDown(o, dirX, dirZ, 9 + 11 * p.dashPower, now);
        }
        if (p.dashLeft <= 0 || !moved) p.act = ACT.NONE; // đi hết quãng hoặc đâm vào tường
        continue;
      }

      // --- Đang choáng, nằm hoặc đứng dậy: không điều khiển được ---
      if (p.act === ACT.STAGGER || p.act === ACT.DOWN || p.act === ACT.GETUP) continue;

      if (len < 0.01) continue;

      // Chuẩn hóa để đi chéo không nhanh hơn đi thẳng
      if (len > 1) {
        dx /= len;
        dz /= len;
      }
      p.rot = Math.atan2(dx, dz); // hướng nhân vật quay mặt

      // --- Đang gồng lực: đứng yên, chỉ xoay người để ngắm hướng lướt ---
      if (p.act === ACT.CHARGE) continue;

      // --- Di chuyển bình thường ---
      p.move = p.run ? 2 : 1;
      const speed = p.run ? RUN_SPEED : PLAYER_SPEED;
      tryMove(p, dx * speed * DT, dz * speed * DT);
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
        a: p.act,
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

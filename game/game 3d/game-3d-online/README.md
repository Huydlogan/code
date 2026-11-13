# Game 3D Online - Bản thử

Nhiều người vào cùng một server, mỗi người điều khiển một nhân vật 3D và thấy nhau di chuyển theo thời gian thực. Server chạy trên Cloudflare (Workers + Durable Objects).

## Chạy thử trên máy

Cần cài [Node.js](https://nodejs.org) (bản LTS) trước. Mở Terminal / PowerShell trong thư mục này:

```
npm install
npm run dev
```

Mở trình duyệt vào `http://localhost:8787`, nhập tên và bấm **Vào chơi**. Để thử nhiều người chơi, mở thêm vài tab cùng địa chỉ đó. Lệnh này giả lập Cloudflare ngay trên máy, nên code chạy ở đây cũng chính là code chạy trên mạng.

## Đưa lên mạng cho mọi người cùng chơi

Cần một tài khoản [Cloudflare](https://dash.cloudflare.com/sign-up) (miễn phí).

```
npx wrangler login
npm run deploy
```

Lệnh đầu chỉ cần chạy một lần (đăng nhập trên trình duyệt). Lệnh sau in ra địa chỉ dạng `https://game-3d-online.<tài-khoản>.workers.dev`; gửi địa chỉ đó cho bạn bè là vào chơi được.

Mỗi lần sửa code xong, chạy lại `npm run deploy`. Người đang chơi sẽ bị ngắt và phải tải lại trang.

## Cấu trúc

| File | Vai trò |
|---|---|
| `src/worker.js` | Server: giữ vị trí mọi người chơi, tính di chuyển và va chạm, chuyển chat |
| `public/index.html` | Client: vẽ cảnh 3D bằng Three.js, gửi phím bấm, nhận vị trí |
| `wrangler.jsonc` | Cấu hình Cloudflare (tên game, file tĩnh, phòng game) |

## Cách hoạt động

1. Cloudflare phát các file trong `public/`. Riêng đường dẫn `/ws` được Worker chuyển tới phòng game.
2. Phòng game là một Durable Object tên `world`: chỉ có đúng một bản, nên mọi người vào cùng một thế giới.
3. Client gửi `join` kèm tên. Server tạo nhân vật và gửi lại bản đồ cùng danh sách người đang online.
4. Khi bấm phím, client gửi `input` chứa **hướng muốn đi** (không gửi vị trí).
5. Server chạy vòng lặp 30 lần/giây: tính vị trí mới, kiểm tra va chạm, rồi gửi `state` cho tất cả. Không còn ai chơi thì vòng lặp dừng để không tốn hạn mức miễn phí.
6. Chat chỉ được chuyển cho những người đứng gần người nói.

## Những thứ bản thử chưa có

- Tài khoản và mật khẩu (hiện chỉ nhập tên, chưa lưu dữ liệu)
- Mô hình 3D thật (hiện là các khối hộp)
- Nhiều phòng / nhiều server, luật chơi, điểm số

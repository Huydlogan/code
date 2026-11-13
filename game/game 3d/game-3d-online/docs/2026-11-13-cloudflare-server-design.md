# Thiết kế: đưa server game lên Cloudflare

Ngày: 2026-11-13

## Mục đích

Đưa bản thử game 3D online lên mạng để nhiều người ở bất kỳ đâu cùng vào một server, không phụ thuộc máy cá nhân. Đây là bước đệm: mô hình server làm ra ở đây sẽ được dùng lại cho các game sau.

## Mục tiêu

- Một địa chỉ cố định `https://<tên>.<tài-khoản>.workers.dev`, mở là chơi được.
- Mọi người vào cùng một thế giới, thấy nhau di chuyển, nhảy, chat theo khoảng cách như bản đang chạy trên máy.
- Luật chơi giữ nguyên: server tự tính vị trí, client chỉ gửi phím bấm.
- Chạy được trong gói miễn phí của Cloudflare.

## Không làm trong lần này

- Tài khoản, mật khẩu, lưu dữ liệu người chơi.
- Nhiều phòng / nhiều server, bản đồ lớn hơn, mô hình 3D thật.
- Tên miền riêng.

## Điều phải tránh

- Luật chơi bị viết hai nơi (một bản cho máy, một bản cho Cloudflare) rồi lệch nhau.
- Server chạy vòng lặp mãi khi không có ai chơi (tốn hạn mức miễn phí).

## Các cách đã cân nhắc

1. **Workers + Durable Objects (đã chọn).** Server chạy hẳn trên Cloudflare, online 24/7, địa chỉ cố định, miễn phí cho bản thử. Phải viết lại `server.js`.
2. **Cloudflare Tunnel từ máy cá nhân.** Không sửa code, nhưng tắt máy là mất game và địa chỉ đổi mỗi lần chạy.
3. **Thuê máy chủ riêng chạy Node.js, Cloudflare đứng trước.** Giữ nguyên code nhưng tốn tiền và phải tự quản máy chủ.

Chọn cách 1 vì đây là bước đệm cho các game sau: học đúng mô hình sẽ dùng lại, và bạn bè vào được bất cứ lúc nào.

## Cách hoạt động

```
Trình duyệt ──(tải trang)──────────▶ Cloudflare phát thư mục public/
Trình duyệt ──(WebSocket /ws)──▶ Worker ──▶ Durable Object "world"
                                             (giữ vị trí mọi người, vòng lặp 30 lần/giây)
```

- **Worker** (`src/worker.js`): nhận yêu cầu. Đường dẫn `/ws` được chuyển tới Durable Object; mọi thứ khác là file tĩnh trong `public/`.
- **Durable Object `GameRoom`**: đúng một bản tên `world` = một server game. Nó giữ danh sách người chơi trong bộ nhớ và chạy vòng lặp game. Toàn bộ luật trong `server.js` hiện tại (di chuyển, va chạm, nhảy, chat gần, chống spam, giới hạn 50 người) chuyển nguyên sang đây.
- **Vòng lặp** chỉ chạy khi có ít nhất một người chơi; người cuối thoát thì dừng, Durable Object tự ngủ.
- **Client** (`public/index.html`): chỉ đổi một dòng, kết nối tới `/ws` thay vì gốc trang.

## Thay đổi file

| File | Việc |
|---|---|
| `src/worker.js` | Mới: Worker + lớp `GameRoom` |
| `wrangler.jsonc` | Mới: cấu hình Cloudflare (file tĩnh, Durable Object) |
| `public/index.html` | Sửa địa chỉ WebSocket thành `/ws` |
| `package.json` | Bỏ `ws`, thêm `wrangler`; lệnh `npm run dev` và `npm run deploy` |
| `server.js` | Xóa (quyết định của Claude, xem dưới) |
| `README.md` | Cập nhật cách chạy và deploy |

## Quyết định của Claude (bạn có thể đổi)

- **Xóa `server.js`.** Chạy thử trên máy sẽ dùng `npm run dev` (Wrangler giả lập Cloudflare ngay trên máy), nên chỉ còn một bản luật chơi. Giữ cả hai thì sớm muộn sẽ lệch nhau.
- **Một phòng duy nhất tên `world`.** Sau này muốn nhiều server chỉ cần đổi tên phòng theo đường dẫn.
- **Giữ định dạng tin nhắn JSON như cũ**, chưa tối ưu băng thông.

## Giới hạn cần biết

- Gói miễn phí: khoảng 100.000 yêu cầu/ngày (20 tin nhắn WebSocket gửi lên tính là 1 yêu cầu) và có hạn mức thời gian chạy Durable Object mỗi ngày. Đủ cho bản thử vài chục người; con số chính xác sẽ kiểm tra lại trên trang Cloudflare khi deploy.
- Khi Cloudflare cập nhật code hoặc khởi động lại Durable Object, mọi người bị ngắt và phải tải lại trang (giống tắt bật server).

## Bạn cần tự làm

- Có tài khoản Cloudflare và chạy `npx wrangler login` một lần (đăng nhập trên trình duyệt). Claude không đăng nhập thay được.

## Xong nghĩa là

- `npm run dev`: mở hai tab, hai nhân vật thấy nhau di chuyển, nhảy, chat gần; va chạm tường đúng.
- `npm run deploy` thành công và địa chỉ `workers.dev` chơi được từ máy khác.

# essential-saga · TypeScript (NestJS)

Shop giày với bốn service NestJS. Mỗi service có cơ sở dữ liệu Postgres riêng, nên không có giao dịch nào bao trọn cả bốn: việc đặt hàng là một saga do `orders` điều phối.

| Service | Cổng | Việc |
| --- | --- | --- |
| `orders` | 4101 | nhận đặt hàng, chạy saga, giữ trạng thái từng lần chạy |
| `payments` | 4102 | trừ tiền, hoàn tiền |
| `stock` | 4103 | giữ hàng, nhả hàng |
| `notify` | 4104 | gửi email cho khách |

## Chạy

Cần Node.js 22 trở lên và Docker.

```bash
npm ci
npm test                 # test đơn vị: luật chuyển trạng thái, thang thử lại, hợp đồng sự kiện
npm run up               # docker compose: Postgres và bốn service
npm run test:e2e         # 11 tình huống, chỉ qua HTTP
npm run down             # tắt và xoá dữ liệu
```

Cổng đã bận thì đặt `ORDERS_PORT`, `PAYMENTS_PORT`, `STOCK_PORT`, `NOTIFY_PORT`, `PG_PORT` trước khi chạy, và đặt `ORDERS_URL=http://localhost:<cổng>`… cho `npm run test:e2e`.

## Các bước

| Bước | Làm | Bước gỡ (chỉ chạy khi có người bấm) |
| --- | --- | --- |
| `order` | tạo đơn `pending` | huỷ đơn |
| `payment` | trừ tiền ví | hoàn tiền |
| `stock` | giữ hàng | nhả hàng |
| `notify` | email "đã đặt" | không có: email đã gửi thì không lấy lại được |

`notify` là bước phụ: nó chỉ báo tin, chạy sau khi ba bước kia xong, và nếu hỏng thì chỉ được ghi lại, đơn vẫn xác nhận. Vì nó chạy sau cùng, đơn bị dừng không bao giờ nhận email "đã đặt".

## Cách code này làm

**Tiến một chiều, gỡ khi có người bấm.** Một bước bị từ chối vì lý do nghiệp vụ (hết hàng, ví không đủ) thì lần chạy dừng ở `failed`, đơn chuyển `on-hold`, khách nhận câu trả lời 409 nói rõ bước nào dừng. Không có gì tự hoàn tiền. Nhân viên xem lần chạy ở `GET /saga-runs/:orderId` rồi quyết định:

```bash
curl -X POST localhost:4101/saga-runs/o-1/compensate -H 'content-type: application/json' -d '{"by":"staff-lan"}'
```

Lúc đó các bước gỡ chạy như bước tiến thường: bước làm sau gỡ trước (hoàn tiền rồi mới huỷ đơn), mỗi bước có thang thử lại riêng.

**Trạng thái có khoá phiên bản.** Mỗi lần chạy là một dòng trong bảng `saga_runs` của `orders`, có `status` và `version`. Mỗi lần đổi trạng thái ghi `WHERE version = <phiên bản vừa đọc>` rồi tăng lên một, nên một lệnh tới trễ hay tới hai lần không đẩy lần chạy đi hai lần. Luật chuyển trạng thái là một hàm thuần (`saga-transition.ts`), test được không cần cơ sở dữ liệu.

**Mã chống trùng cố định.** Mỗi lệnh gửi sang service khác mang `Idempotency-Key` cố định theo bước và theo đơn, không bao giờ sinh ngẫu nhiên. Bên nhận ghi nhận mã đó trong cùng giao dịch với việc nó làm và cất lại câu trả lời, nên lần gửi lại nhận đúng câu trả lời cũ, tiền không đi hai lần.

**Thử lại có giới hạn.** Một lỗi không có câu trả lời hoặc 5xx được thử lại theo thang chờ (`LADDER_WAITED_MS` cho việc khách đang chờ, `LADDER_BACKGROUND_MS` cho việc chạy nền). Hết thang thì lần chạy `parked`: một dòng nhân viên thấy và bấm "chạy lại" (`POST /saga-runs/:orderId/resume`). Bước đang dở mà không rõ kết quả được đánh dấu `unclearStep`; nếu nhân viên chọn huỷ đơn, bước gỡ của nó chạy trước, và gỡ một việc chưa từng xảy ra thì không đổi gì.

**Sập rồi chạy tiếp.** `orders` chết giữa chừng thì lúc khởi động lại, trước khi mở cổng, nó đọc `saga_runs` và chạy tiếp mọi lần chạy còn dở từ đúng chỗ đã dừng; một vòng quét định kỳ làm tiếp những gì còn sót.

**Đặt hàng hai lần.** `orderId` là mã chống trùng của chính lần đặt: lần thứ hai không mở lần chạy mới mà nhận lại câu trả lời của lần đầu.

## Khác gì file `saga.ts` của bạn

Trong lab, hết hàng sau khi đã trừ tiền thì code của bạn tự hoàn tiền và huỷ đơn ngay, khách nhận lại tiền liền. Ở đây tiền chỉ về khi có người bấm. Đổi lại, không có lần gỡ nào chạy ngầm mà không ai biết, và nếu chính việc gỡ hỏng thì nó dừng ở một dòng có người nhìn thấy.

Một khác biệt nữa: khi một bước không có câu trả lời, lab của bạn hỏi trạng thái bên kia rồi quyết định. Ở đây code gửi lại đúng lệnh cũ với đúng mã cũ; bên nhận đã làm thì trả lại kết quả cũ. Vẫn không rõ sau cả thang thử lại thì dừng và chờ người.

## Mã nguồn

```
src/platform/                          dùng chung: cơ sở dữ liệu, ghi nhận mã chống trùng, http client, công tắc sự cố cho test
src/orders/platform/saga/              luật chuyển trạng thái, kho trạng thái có khoá phiên bản, bộ chạy saga
src/orders/platform/jobs/ladder.ts     phân loại lỗi và thang thử lại
src/orders/features/saga/checkout/     saga đặt hàng: steps/, compensations/, trạng thái, phần điều phối, phục hồi
src/orders/features/api/               cửa cho khách (đặt hàng) và cho nhân viên (xem, gỡ, chạy lại)
src/payments, src/stock, src/notify    ba service còn lại
contracts/events.json                  sự kiện của từng bước, sự kiện gỡ ghi rõ nó gỡ sự kiện nào
test/unit, test/e2e                    test đơn vị và 11 tình huống qua HTTP
```

## Công tắc sự cố (chỉ cho test)

Chỉ mở khi service chạy với `TEST_HOOKS=on` (docker-compose.yml bật sẵn; môi trường thật thì không). Bật bằng `PUT /test/faults`, đặt lại dữ liệu mẫu bằng `POST /test/reset`.

| Công tắc | Tác dụng |
| --- | --- |
| `STOCK_OUT` | kho báo hết hàng |
| `NET_FLAKY` | lần gọi đầu của thao tác được chọn hỏng với 503 |
| `DUP_EVENT` | mỗi lệnh tới hai lần |
| `LOST_RESPONSE` | lệnh tới nơi nhưng mất câu trả lời (một lần; `always:<thao tác>` thì mọi lần) |
| `CRASH_AT` | `before:<thao tác>` hoặc `after:<thao tác>`: process `orders` thoát, Docker bật lại |

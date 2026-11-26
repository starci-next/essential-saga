# essential-saga

Bản tham chiếu chuẩn của bài Saga trong Essentials của StarCi Next.

Trong bài, bạn sửa một file `saga.ts` của shop giày cho tới khi mọi tình huống xanh. Repo này là cùng shop đó (orders, payments, stock, notify, mỗi service một cơ sở dữ liệu riêng), viết theo cách một đội làm sản phẩm thật sẽ viết: chia thư mục rõ ràng, trạng thái của mỗi lần chạy được ghi lại và có khoá phiên bản, mọi lệnh mang mã chống trùng, và có bộ test chạy qua HTTP cho từng tình huống.

Repo đứng một mình: chỉ cần Node.js, npm và Docker. Không cần StarCi CLI hay bất kỳ công cụ riêng nào.

## Mỗi ngôn ngữ một thư mục

| Thư mục | Ngôn ngữ | Trạng thái |
| --- | --- | --- |
| [`typescript/`](typescript/) | TypeScript, NestJS, Postgres | có |
| `go/` | Go | sẽ có sau |
| `rust/` | Rust | sẽ có sau |

Mỗi thư mục là một dự án trọn vẹn, chạy độc lập, cùng một shop và cùng các tình huống.

## Lấy về cạnh lab của bạn

Nếu bạn đang học bằng StarCi Relay:

```bash
starci-relay ref saga --lang typescript
```

Lệnh này tải đúng thư mục `typescript/` ở commit mà trang Nộp bài ghim, đặt cạnh thư mục lab của bạn. Không cần đăng nhập, vì repo này công khai.

Hoặc tự clone:

```bash
git clone https://github.com/starci-next/essential-saga.git
cd essential-saga/typescript
```

## Khác gì file của bạn

Điểm khác lớn nhất: trong lab, khi kho báo hết hàng sau khi đã trừ tiền, code của bạn tự hoàn tiền rồi huỷ đơn ngay. Ở đây thì không. Đơn dừng ở trạng thái "chờ xử lý", khách được báo thật là đơn đã tới nhưng chưa xong, và tiền chỉ được hoàn khi một nhân viên bấm nút huỷ đơn. Lúc đó các bước gỡ chạy như những bước tiến bình thường, bước làm sau gỡ trước, mỗi bước có thử lại riêng.

Vì sao: việc gỡ cũng có thể hỏng giữa chừng. Để một người quyết định và nhìn thấy nó chạy thì dễ kiểm soát hơn một phản xạ tự động mà không ai thấy. Chi tiết ở [`typescript/README.md`](typescript/README.md).

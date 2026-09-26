# ĐẶC TẢ KỸ THUẬT & KIỂM ĐỊNH MÃ NGUỒN (THCS CHU VĂN AN EDUSIGN)

## 1. Tổng Quan Hệ Thống
Hệ thống Quản lý Ký số Giáo án & Báo cáo Chuyên môn Điện tử Trường THCS Chu Văn An (EduSign THCS CVA) vận hành trên nền tảng Web Node.js/Express, kết hợp Firebase Realtime Database và ứng dụng ký số ngoại vi EduSign Agent (C# / VGCA Mobile SmartCA & USB Token PKCS#11).

## 2. Ma Trận Nghiệp Vụ Ký Số 3 Tùy Chọn

### 2.1. Tùy chọn 1: Kế Hoạch Bài Dạy / Ký Cá Nhân (`LESSON_PLAN`)
- **Đối tượng**: Giáo viên, Tổ trưởng chuyên môn, Lãnh đạo Ban Giám hiệu.
- **Quy trình**: Ký độc lập không luân chuyển (`isChainedSigning = false`).
  - Giáo viên: Tải giáo án cá nhân lên, định vị chữ ký, ký số qua SmartCA hoặc USB Token, tải về máy hoặc đồng bộ Google Drive cá nhân.
  - Tổ trưởng: Ký giáo án của mình hoặc tự làm báo cáo nội bộ độc lập lưu kho tổ.
  - Ban Giám hiệu: Ký văn bản cấp trường độc lập, ký và đóng dấu mộc đỏ trực tiếp (`COMPLETED`, `hasSchoolSeal = true`).

### 2.2. Tùy chọn 2: Báo Cáo Chuyên Môn Nội Bộ - Tổ/Khối (`INTERNAL_REPORT`)
- **Đối tượng**: Báo cáo chuyên môn nội bộ tổ, biên bản họp tổ/nhóm chuyên môn, kế hoạch hoạt động tổ.
- **Ràng buộc con dấu**: TUYỆT ĐỐI KHÔNG CÓ DẤU MỘC ĐỎ NHÀ TRƯỜNG (`requiresSeal: false`, `hasSchoolSeal: false`).
- **Danh sách người nhận**: Ẩn 100% tài khoản Ban Giám hiệu (`isUserBgh(u) === false`). Chỉ hiển thị Giáo viên và Tổ trưởng các tổ.
- **Quyền Vừa ký vừa duyệt (Self-Approval)**:
  - **Tổ trưởng chuyên môn**: Được phép tích chọn "Tôi là Tổ trưởng phê duyệt hoàn tất báo cáo nội bộ này (Không chuyển tiếp)". Checkbox tự duyệt (`#cbSelfApproval`) **mặc định bỏ chọn (`checked = false`)**, yêu cầu người dùng phải chủ động tích chọn, tuyệt đối không kích hoạt ngầm. Khi tích chọn, ẩn dropdown người nhận, nút ký chuyển thành `VỪA KÝ VỪA DUYỆT HOÀN TẤT`. Khi ký xong, văn bản đạt trạng thái `COMPLETED` ngay lập tức và lưu vào Kho Báo cáo số của trường/tổ.
  - **Giáo viên thường**: BẮT BUỘC phải chọn người ký tiếp theo trong tổ hoặc liên tổ (`selectNextSigner`). Hệ thống chặn mã lỗi 400 nếu gửi báo cáo mà thiếu người nhận.

### 2.3. Tùy chọn 3: Báo Cáo / Biên Bản Trình Nhà Trường (`SCHOOL_REPORT`)
- **Đối tượng**: Báo cáo tổng kết, biên bản hội đồng, văn bản trình cấp trường phê duyệt pháp nhân.
- **Ràng buộc con dấu**: BẮT BUỘC ĐIỂM ĐẾN CUỐI CÙNG LÀ BAN GIÁM HIỆU VÀ PHẢI CÓ DẤU MỘC ĐỎ PHÁP NHÂN (`requiresSeal: true`).
- **Danh sách người nhận**: Hiển thị Giáo viên, Tổ trưởng VÀ Ban Giám hiệu (có nhãn `[BGH - Đóng dấu]`).
- **Quyền hạn & Luân chuyển**:
  - **Ban Giám hiệu**: Có quyền tự ký duyệt và đóng dấu mộc đỏ hoàn tất trực tiếp (`isSelfApproved = true`, `hasSchoolSeal = true`, trạng thái `COMPLETED`). Checkbox tự duyệt đóng dấu trên giao diện mặc định bỏ chọn (`checked = false`).
  - **Tổ trưởng chuyên môn**: BẮT BUỘC chọn Ban Giám hiệu để trình duyệt (`KÝ & TRÌNH BAN GIÁM HIỆU`).
  - **Giáo viên thường**: Có thể phối hợp gửi cho đồng nghiệp hoặc gửi lên Tổ trưởng hoặc gửi thẳng cho BGH. Báo cáo chỉ hoàn tất khi BGH đã ký và đóng dấu mộc đỏ.

## 3. Kiến Trúc Giao Diện & Tiêu Chuẩn Nút Làm Mới (Smart Refresh)
- **Triệt tiêu nút trùng lặp**: Loại bỏ hoàn toàn 3 nút làm mới con rải rác trong Header Tab 2, Tab 3, Tab 5 và nút trên Teacher Header.
- **Điểm neo duy nhất**:
  - Giáo viên: Sử dụng nút `Smart Refresh` duy nhất đặt trên thanh Tab Bar (`#btnTeacherTabBarRefresh`).
  - Quản trị viên: Sử dụng nút `Smart Refresh` trên Header Quản trị (`#btnAdminRefresh`).
- **Cơ chế hoạt động**: Hàm `handleSmartRefresh()` kích hoạt làm mới đồng bộ có cơ chế chống spam (rate-limiting 3s, khóa token `_isSmartRefreshing`), hiển thị hiệu ứng xoay icon SVG, và đồng thời cập nhật dữ liệu cả 4 tab: Tab 1 (Chờ ký), Tab 2 (Đang luân chuyển), Tab 3 (Tiến độ hồ sơ), Tab 5 (Kho Báo cáo & Biên bản).

## 4. Tiêu Chuẩn An Toàn Dữ Liệu & Mã Nguồn
- **Tuân thủ nghiêm ngặt chuẩn doanh nghiệp Alibaba Open-Code-Review**: Không sử dụng `var`, không so sánh lỏng `==`, tuyệt đối không nuốt ngoại lệ im lặng (triệt tiêu 100% `catch (() => {})` và `void err;` trên toàn hệ thống từ server tới client `js/app.js`). Mọi thao tác async và API call đều có cơ chế bắt lỗi cấu trúc, ghi nhận log và cảnh báo người dùng khi mạng gián đoạn.
- **Chống Race Condition & Khóa Đa Tiến Trình Chuẩn Công Nghiệp (Owner-Guarded Multi-Process Atomic Lock)**: 
  - Áp dụng Multi-Process Persistent Atomic Lock dựa trên cờ nguyên tử hệ điều hành `wx` (`O_CREAT | O_EXCL`) trong thư mục `data/locks/`.
  - Mỗi yêu cầu xin lock được gán một `lockToken` (UUID ngẫu nhiên) và `bootId` định danh phiên chạy của tiến trình Node.js.
  - **Thu hồi Stale Lock nguyên tử**: Khi phát hiện lock chết (`PID` không còn tồn tại qua `process.kill(pid, 0)` và quá hạn TTL 30s), hệ thống sử dụng `fs.renameSync(lockFilePath, staleCandidatePath)` nguyên tử để di dời lock cũ, triệt tiêu hoàn toàn race condition khi nhiều worker cùng phát hiện lock chết.
  - **Bảo vệ quyền sở hữu khi giải phóng lock (Owner-Guarded Release)**: Hàm `releaseDocumentLock(docId, lockToken)` chỉ được phép di dời và xóa file lock nếu `lockToken` trong file trùng khớp với token của tiến trình sở hữu, chống hiện tượng tiến trình chạy chậm xóa nhầm lock của tiến trình khác sau khi bị reclaim.
- **Giao Dịch Bền Vững & Nhật Ký Phục Hồi Hai Chiều (Recovery Journal & Two-Way Crash Recovery)**:
  - Sử dụng Transaction Journal lưu tại `data/transactions/<id>.tx.json` với các trạng thái `PREPARING`, `STAGED`, `DB_COMMITTED`, `ROLLBACK_REQUIRED`.
  - Quy trình nguyên tử: Ghi Journal `PREPARING` -> Ghi tệp đệm `uploads/documents/staging/doc_<id>.pdf.stage` -> Ghi Journal `STAGED` -> Commit Database bền vững đồng bộ (`saveJsonSafeSync`) -> Cập nhật Journal `DB_COMMITTED` -> Rename nguyên tử sang `uploads/documents/` -> Xóa Journal.
  - **Thứ tự Rollback An Toàn & Khóa Lỗi Fail-Closed (Fail-Closed Rollback & Journal Lifecycle)**: Khi phát sinh lỗi trong khối tạo hồ sơ, hệ thống cập nhật journal sang `ROLLBACK_REQUIRED` trước, tiến hành xóa bản ghi DB và dọn dẹp file, và chỉ xóa journal khi toàn bộ quá trình rollback đã hoàn tất thành công 100%. Hàm `removeTransactionJournal(safeDocId)` trả về boolean (`true`/`false`). Trong cả quá trình rollback lúc runtime lẫn khi khởi động (`reconcileOrphanDocumentsOnStartup`), mọi lỗi xóa file/DB đều được log có cấu trúc và đánh dấu `rollbackSuccess = false`; nếu có bất kỳ bước nào thất bại, hệ thống giữ nguyên journal `ROLLBACK_REQUIRED` để tiếp tục thử lại ở lần khởi động tiếp theo (fail-closed, tuyệt đối không nuốt ngoại lệ im lặng).
  - **Đối soát hai chiều khi khởi động (Startup Reconciliation)**: Hàm `reconcileOrphanDocumentsOnStartup()` tự động quét thư mục Journal và đối soát hai chiều giữa DB và Filesystem:
    + Khi gặp Journal `STAGED`: Kiểm tra DB trước; nếu bản ghi DB đã được commit (crash xảy ra ngay trước khi journal đổi sang `DB_COMMITTED`), hệ thống thăng hạng và tiếp tục hoàn tất di dời file sang production; nếu DB chưa commit, dọn dẹp file staging mồ côi và journal.
    + Khi gặp Journal `DB_COMMITTED`: Đối soát SHA-256 hash giữa staging và production; nếu trùng khớp dọn staging thừa; nếu chỉ có staging thì hoàn tất rename sang production.
    + **Bảo toàn Hồ sơ Đám mây (Cloud-First Preservation)**: Tuyệt đối không xóa nhầm các hồ sơ có liên kết lưu trữ đám mây (Google Drive `googleDriveUrl`, `driveUrl`, `driveFileId`, `driveInfo`); áp dụng cho cả nhánh journal rollback và nhánh quét đối soát hai chiều. Chỉ rollback các bản ghi local-only quá hạn 60s mà mất hoàn toàn file vật lý ở cả staging và production.
- **Xác Minh Con Dấu Pháp Nhân Dựa Trên Artifact Thực Tế (School Seal Artifact Guard & Privilege Escalation Prevention)**:
  - Chỉ Ban Giám hiệu có thẩm quyền đóng dấu VÀ có chỉ định đóng dấu pháp nhân rõ ràng (`req.body.hasSchoolSeal === true`, `isSchoolSeal === true`, hoặc role `CON_DAU_NHA_TRUONG`) trên Báo cáo cấp trường (`SCHOOL_REPORT`) kèm nội dung tệp PDF hợp lệ (`rawBuffer.length >= 50`) mới được cấp cờ `hasSchoolSeal = true` và cờ canonical nội bộ `verifiedSchoolSeal = true`.
  - Hàm `dataStore.createDocument()` mặc định gán `hasSchoolSeal = false` và chỉ chấp nhận đóng dấu pháp nhân khi `categoryType !== 'INTERNAL_REPORT'` VÀ `verifiedSchoolSeal === true`. Mọi nỗ lực truyền trực tiếp `hasSchoolSeal: true` từ caller không được xác minh đều bị triệt tiêu hoàn toàn.
  - Nghiêm cấm tự suy diễn `hasSchoolSeal = true` chỉ dựa vào quyền hạn Ban Giám hiệu nếu thiếu chỉ định đóng dấu pháp nhân.
- **Quyền Tự Duyệt Chặt Chẽ & Phân Định 3 Trạng Thái BGH (Strict Self-Approval & BGH 3-State Model)**:
  - Chỉ chấp nhận `req.body.isSelfApproved === true` để kích hoạt quyền tự duyệt. Cờ `isFinal: true` đơn độc không được nâng quyền thành tự duyệt trên route `/api/documents/forward`.
  - Phân định rõ 3 trạng thái xử lý hồ sơ của Ban Giám hiệu:
    + **TH1 - Tự duyệt nội dung**: BGH gửi `isSelfApproved: true` trên `SCHOOL_REPORT` nhưng không yêu cầu đóng dấu (`!requestedSealIntent`) -> Hồ sơ chuyển sang `PENDING_SEAL` (chờ đóng dấu mộc đỏ sau), ghi nhận `bghApprovedAt`, `bghSigner`, và không bắt buộc chọn người nhận tiếp theo (`nextSignerId = null`).
    + **TH2 - Tự duyệt & Đóng dấu hoàn tất**: BGH gửi `isSelfApproved: true` kèm chỉ định đóng dấu pháp nhân hợp lệ trên `SCHOOL_REPORT` -> Hồ sơ chuyển sang `COMPLETED`, `hasSchoolSeal = true`, `verifiedSchoolSeal = true`.
    + **TH3 - Không tự duyệt**: Bắt buộc chọn người nhận tiếp theo hợp lệ từ cơ sở dữ liệu (`nextSignerId`); nếu thiếu trả 400 Bad Request.
- **Chuẩn hóa Server-Side Canonical Enum**: Server tự phân giải loại báo cáo duy nhất (`SCHOOL_REPORT` vs `INTERNAL_REPORT`), chặn 400 nếu client gửi cờ con dấu mâu thuẫn.
- **Xác thực Quyền Thời gian thực Fail-Closed (Fresh Role DB Verification)**: Luôn tra cứu vai trò từ cơ sở dữ liệu `dataStore`, từ chối 401/403 nếu tài khoản không tồn tại, bị khóa, hoặc stale token mạo danh.
- **Chống DoS Socket Stream Đa Chế Độ & Kiểm Định Tệp (Stream Guard, Magic Bytes & Base64 DoS Protection)**: Middleware stream guard giám sát trực tiếp lưu lượng byte từ socket qua hàm helper `rejectStreamOversized` thống nhất, chặn đứng cả `Content-Length > 35MB` lẫn `Transfer-Encoding: chunked` vượt quá 35MB ngay tại tầng mạng trước khi `express.json` parse và cấp phát RAM; ngay lập tức unpipe/pause request, đánh dấu `req._streamRejected = true` ngăn chặn toàn bộ parser và route downstream xử lý tiếp, phản hồi 413 kèm `Connection: close`, và kích hoạt đóng socket có cơ chế failsafe timer; kiểm tra độ dài chuỗi Base64 `<= 35MB`; kiểm tra tiêu đề `%PDF-` hợp lệ và cấu trúc kết thúc `%%EOF` trên mọi luồng nộp và ký tiếp.
- **Bảo Vệ Xác Thực & Phân Quyền Tuyến Ký Tiếp (Chained Sign-Step Security Boundary)**:
  - Tuyến `POST /api/documents/:id/sign-step` bắt buộc được bảo vệ bằng middleware `requireAuth`.
  - Tra cứu lại danh tính người dùng thời gian thực từ `dataStore` bằng identity trong token; từ chối 401 nếu tài khoản không tồn tại, từ chối 403 nếu tài khoản bị khóa (`status: 'LOCKED'`). Tuyệt đối không tin tưởng `x-user-id`, `x-user-role`, `req.body.currentUser` hoặc cờ client.
  - Phân quyền nghiêm ngặt: Chỉ người dùng được phân công (`doc.assignedTo`, `doc.currentSignerId`, `doc.nextSignerId`) hoặc Ban Giám hiệu mới có quyền ký bước tiếp theo; từ chối 403 nếu giáo viên khác cố tình can thiệp.
  - Xác thực người nhận tiếp theo (`nextSignerId`): Khi chuyển tiếp (`!isFinal`), bắt buộc tra cứu người nhận từ DB, từ chối 400 nếu không tồn tại, từ chối 403 nếu tài khoản bị khóa; lấy tên hiển thị chuẩn từ DB (`actualNextSignerName`) thay vì tin cậy client; từ chối 403 nếu cố tình chuyển tiếp `INTERNAL_REPORT` lên Ban Giám hiệu; bắt buộc chuyển tiếp lên Ban Giám hiệu nếu Tổ trưởng ký trên `SCHOOL_REPORT`.
  - Báo cáo cấp trường (`SCHOOL_REPORT`): Bắt buộc chỉ Ban Giám hiệu mới có quyền phê duyệt hoặc xác nhận hoàn tất (`isFinal: true`). Tuyệt đối từ chối 403 Forbidden nếu người không phải Ban Giám hiệu (giáo viên, tổ trưởng) gửi `isFinal: true` trên Báo cáo cấp trường. Chỉ Ban Giám hiệu mới có thẩm quyền chuyển trạng thái sang `PENDING_SEAL` (kèm `bghApprovedAt`, `bghSigner` thật).
  - Đóng dấu pháp nhân trên `sign-step`: Bắt buộc hồ sơ phải đang ở trạng thái `PENDING_SEAL` (đã qua bước BGH duyệt nội dung hợp lệ) mới được phép đóng dấu mộc đỏ `isRealSchoolSeal = true` để hoàn tất `COMPLETED`. Từ chối 400 nếu cố tình đóng dấu khi hồ sơ còn đang ở `PENDING_SIGN`.
  - Báo cáo nội bộ (`INTERNAL_REPORT`): Tuyệt đối không có dấu mộc đỏ (`hasSchoolSeal: false`); máy chủ lập tức từ chối 400 nếu client gửi yêu cầu đóng dấu. Chỉ Tổ trưởng chuyên môn hoặc Ban Giám hiệu mới có quyền phê duyệt hoàn tất (`isFinal: true`); giáo viên thường gửi `isFinal: true` bị từ chối 403 Forbidden.
  - Bất biến Trạng thái Chờ Đóng Dấu (`PENDING_SEAL Invariant Guard`): Trạng thái `PENDING_SEAL` bắt buộc phải có `bghApprovedAt` và `bghSigner` hợp lệ. Hệ thống tự động đối soát và khôi phục an toàn về `PENDING_SIGN` khi khởi động nếu phát hiện dữ liệu thiếu metadata BGH, và từ chối đóng dấu nếu hồ sơ chưa qua bước phê duyệt hợp lệ của Ban Giám hiệu.
  - Kiểm tra tính hợp lệ của tệp PDF (%PDF- và %%EOF), khóa độc quyền `acquireDocumentLock` / `releaseDocumentLock` (với `LOCK_DIR` được khởi tạo đồng bộ ngay khi nạp module) ngăn chặn replay attack và xung đột tương tranh.
  - **Cơ chế Commit Hai Pha & Rollback Artifact Vật Lý (Two-Phase Commit in sign-step)**: Tuyến `sign-step` bao bọc toàn bộ quy trình ghi artifact bằng Transaction Journal (`SIGN_STEP_PREPARING`). Trước khi ghi đè file cũ, hệ thống tạo bản sao lưu tạm `.bak`. Nếu việc cập nhật database `updateDocument` thất bại, hệ thống tự động hoàn nguyên file vật lý về trạng thái cũ hoặc xóa file mới tạo; nếu việc hoàn nguyên file thất bại, journal được cập nhật sang `ROLLBACK_REQUIRED` để startup reconciliation dọn dẹp, triệt tiêu hoàn toàn lỗi orphan file lệch pha DB.
- **Giao Dịch Ghi File Nguyên Tử & Triệt Tiêu In-Place Fallback (Atomic Commit Guard in dataStore)**:
  - Hàm `saveJsonSafeSync` tuyệt đối không fallback sang ghi đè trực tiếp `fs.writeFileSync(filePath, content)` khi `renameSync` gặp lỗi khóa tạm thời trên Windows; thay vào đó thực hiện vòng lặp retry nguyên tử (spin-wait), dọn dẹp file tạm và throw Error nếu không thành công để kích hoạt rollback giao dịch mà không làm hỏng dữ liệu gốc.
  - Hàm `saveUsers` thực hiện ghi đồng bộ nguyên tử `saveJsonSafeSync`, tuyệt đối không bắt nuốt lỗi fallback sang hàng đợi async rồi return `true`, đảm bảo tính toàn vẹn fail-closed và đồng bộ 100% giữa RAM cache và đĩa cứng.
  - Các hàm `updateDocument` và `deleteDocument` thực hiện ghi đồng bộ nguyên tử `saveJsonSafeSync`, ném lỗi sạch sẽ khi thất bại, không bắt nuốt ngoại lệ hay fallback sang hàng đợi bất đồng bộ gây lệch pha giữa RAM và đĩa cứng.
  - Mọi thao tác rollback xóa bản ghi DB (`deleteDocument`) đều kiểm tra kết quả boolean và tái xác minh sự biến mất của bản ghi trong database trước khi dọn dẹp journal phục hồi (`rollbackSuccess = false` nếu bản ghi vẫn còn). Trong cả `reconcileOrphanDocumentsOnStartup` lẫn route runtime, nếu xóa DB thất bại, journal được chuyển sang/giữ nguyên `ROLLBACK_REQUIRED` (với giới hạn retryCount <= 5 trước khi chuyển `MANUAL_AUDIT_REQUIRED` để tránh nghẽn khởi động) để tiếp tục cứu hộ ở lần khởi động sau. Khi đối soát hai chiều phát hiện bản ghi DB mồ côi không có file vật lý mà xóa DB thất bại, hệ thống cũng chủ động ghi nhận journal `ROLLBACK_REQUIRED` fail-closed.
- **Xác Thực Vai Trò Thời Gian Thực & Tự Động Invalidate Cache (Fresh Role DB Verification & Cache Invalidation Law)**:
  - Mọi thao tác xác thực và phân quyền nhạy cảm (`verifyToken`, `getCurrentUser`, `requireAuth`, `requireAdmin`, `forward`, `sign-step`) BẮT BUỘC phải tra cứu trạng thái và vai trò người dùng fresh từ cơ sở dữ liệu (`dataStore.getUserById(id, true)` / `dataStore.getUserByUsername(username, true)`).
  - Hàm `getUsers()` trong `dataStore.js` tự động theo dõi thời gian sửa đổi tệp (`mtimeMs` của `users.json`). Bất cứ khi nào dữ liệu người dùng trên đĩa bị thay đổi (bởi admin hoặc tiến trình khác), cache RAM tự động được làm mới ngay lập tức, triệt tiêu hoàn toàn hiểm họa stale authorization, bypass tài khoản bị khóa, hoặc privilege escalation.
- **Nhật Ký Giao Dịch Nguyên Tử & Phòng Chống Corrupt Journal (ACID Atomic Transaction Journal Law)**:
  - Mọi thao tác ghi và cập nhật Transaction Journal bắt buộc sử dụng `writeJournalFileAtomic` thông qua tệp tạm `.tmp`, gọi `fs.fsyncSync` đẩy toàn bộ dữ liệu xuống đĩa vật lý trước khi `fs.renameSync`. Tuyệt đối cấm ghi đè trực tiếp `fs.writeFileSync(jPath, ...)` lên file journal đang tồn tại.
  - Khi khởi động máy chủ, nếu phát hiện tệp journal bị lỗi cú pháp JSON do tiến trình bị crash giữa chừng, hệ thống sao lưu sang bản ghi chứng cứ `.corrupt.<timestamp>` và tự động cập nhật journal sang trạng thái `MANUAL_AUDIT_REQUIRED`, tuyệt đối không nuốt ngoại lệ im lặng hay xóa mất journal cứu hộ.
- **Bảo Tồn Nhật Ký Đám Mây Chờ Đối Soát (Cloud-Preserved Journal Fail-Closed Invariant)**:
  - Khi một hồ sơ mất cả tệp local và staging nhưng cơ sở dữ liệu có thông tin lưu trữ đám mây (`googleDriveUrl`, `driveUrl`, `driveFileId`, `driveInfo`), hệ thống bảo tồn nguyên vẹn bản ghi trong DB và BẮT BUỘC giữ lại Transaction Journal ở trạng thái `CLOUD_RECOVERY_REQUIRED` (lý do `MISSING_LOCAL_FILES_PENDING_CLOUD_VERIFY`), tuyệt đối không tự ý xóa journal khi chưa có kết nối API xác thực trực tiếp artifact trên cloud.
- **Thẩm Tra Artifact Con Dấu & Chữ Ký Số Thực Tế (School Seal Artifact Guard - Dual Condition Law)**:
  - Cờ con dấu pháp nhân `hasSchoolSeal = true`, `verifiedSchoolSeal = true` và trạng thái `COMPLETED` của Báo cáo cấp trường CHỈ được cấp khi tệp PDF tải lên vượt qua hàm kiểm định `verifySchoolSealArtifact(rawBuffer)`.
  - **Quy tắc Hai Điều Kiện Cứng (Dual Condition Rule)**:
    1. Chữ ký cá nhân thông thường (chỉ chứa `/Type /Sig`, `/ByteRange`) TUYỆT ĐỐI KHÔNG được coi là con dấu trường nếu thiếu định danh/metadata con dấu pháp nhân nhà trường.
    2. Text keyword đơn độc trong phần thân PDF TUYỆT ĐỐI KHÔNG được coi là artifact con dấu nếu thiếu cấu trúc chữ ký số điện tử hoặc đối tượng hình ảnh con dấu (`/Subtype /Image`).
    3. Hợp lệ khi và chỉ khi: `(hasDigitalSigStructure && hasSealKeyword)` HOẶC `(hasImageXObject && hasSealKeyword)`.
- **Cấm Tuyệt Đối Tự Suy Diễn Metadata BGH Trong Cơ Sở Dữ Liệu (BGH Metadata Strict Non-Fallback Invariant)**:
  - Trong `createDocument()` của `dataStore.js`, `bghApprovedAt` và `bghSigner` mặc định là `null`.
  - Chỉ chấp nhận giá trị khi được truyền tường minh dưới dạng chuỗi hợp lệ không rỗng từ phiên xác thực Ban Giám hiệu chính danh.
  - CẤM TUYỆT ĐỐI fallback sang `creatorName`, `updatedAt`, `new Date()` hoặc chuỗi `'Ban Giám hiệu'` cho các hồ sơ không được BGH phê duyệt trực tiếp.
- **Chuẩn Hóa Đường Dẫn & Bảo Vệ Vùng Quản Trị Tệp (Upload Boundary & Path Traversal Guard)**:
  - Hệ thống định nghĩa ranh giới thư mục quản lý tệp tin bất biến: `UPLOAD_ROOT = path.resolve(__dirname, 'uploads', 'documents')`.
  - Hàm `isWithinUploadRoot(targetPath)` kiểm tra tính toàn vẹn tuyệt đối qua `path.relative(UPLOAD_ROOT, resolvedPath)`. Mọi đường dẫn chứa `../` hoặc nằm ngoài phạm vi `UPLOAD_ROOT` đều bị từ chối triệt để.
  - Hàm `resolveLocalDocumentPath(doc)` chỉ trả về các đường dẫn hợp lệ nằm trong `UPLOAD_ROOT`, triệt tiêu 100% hiểm họa Path Traversal và rủi ro thao tác nhầm lên các tệp tin hệ thống.
- **Lá Chắn Bảo Toàn Tệp Tin Đang Hoạt Động Khi Rollback (Active DB Document Rollback Shield)**:
  - Trong quá trình phục hồi sự cố (`reconcileOrphanDocumentsOnStartup`), trước khi thực hiện xóa tệp `savedFilePath` thuộc journal `ROLLBACK_REQUIRED`:
  - Hệ thống BẮT BUỘC đối soát toàn diện với tất cả các hồ sơ đang hoạt động trong cơ sở dữ liệu (`dataStore.getDocuments()`).
  - Nếu tệp tin `savedFilePath` đang được bất kỳ hồ sơ DB hợp lệ nào tham chiếu, hoặc đường dẫn nằm ngoài `UPLOAD_ROOT`, hệ thống TUYỆT ĐỐI KHÔNG ĐƯỢC XÓA FILE; thay vào đó bảo tồn nguyên vẹn tệp vật lý và chuyển trạng thái Transaction Journal sang `MANUAL_AUDIT_REQUIRED`.
- **Mô Hình Transactional Outbox Cho Đồng Bộ Ngoại Vi (Transactional Outbox Pattern in sign-step)**:
  - Khi hoàn tất bước ký cuối cùng (`isTrulyCompleted`), hệ thống chuyển Transaction Journal sang trạng thái `EXTERNAL_SYNC_PENDING`, cấp phát `idempotencyKey` bất biến và cập nhật `doc.syncStatus = 'SYNC_PENDING'` bền vững trong cơ sở dữ liệu.
  - Tác vụ đồng bộ Google Drive bắt buộc kiểm tra artifact đã tồn tại (`doc.googleDriveUrl` hoặc `doc.driveInfo?.viewUrl`) để tái sử dụng, triệt tiêu hoàn toàn rủi ro upload trùng lặp tệp ngoại vi khi tiến hành retry.
  - Sau khi các tác vụ đồng bộ bên ngoài hoàn tất, hệ thống BẮT BUỘC tái xác minh DB đã lưu bền vững `SYNC_COMPLETED` hoặc `SYNC_PENDING_RETRY` mới được dọn dẹp Transaction Journal (`removeTransactionJournal`). Nếu cập nhật DB thất bại, hệ thống bảo tồn nguyên vẹn journal `EXTERNAL_SYNC_PENDING` để retry ở lần khởi động sau (fail-closed, tuyệt đối không nuốt ngoại lệ im lặng).
  - Khi khởi động lại, `reconcileOrphanDocumentsOnStartup()` tự động phát hiện journal `EXTERNAL_SYNC_PENDING`, cập nhật DB sang `SYNC_PENDING_RETRY` và chỉ xóa journal khi DB đã xác nhận cập nhật thành công.
- **Quản Trị Concurrency Cho Heavy Payload (Heavy Payload Concurrency Semaphore)**:
  - Hệ thống tích hợp middleware Semaphore kiểm soát tải đồng thời cho các payload dung lượng lớn ($\ge 5\text{MB}$) trước khi cấp phát bộ nhớ RAM cho parser:
  - Giám sát đồng thời cả hai giao thức truyền dữ liệu: HTTP request có `Content-Length` và `Transfer-Encoding: chunked`.
  - Giới hạn tối đa $6$ requests tải tệp lớn đồng thời toàn hệ thống và tối đa $3$ requests tải tệp lớn trên cùng một địa chỉ IP.
  - Khi vượt ngưỡng concurrency cho phép, hệ thống lập tức từ chối với mã phản hồi HTTP `429 Too Many Requests` (kèm header `Retry-After: 2`), triệt tiêu 100% rủi ro cạn kiệt bộ nhớ RAM (OOM Crash DoS) trên môi trường máy chủ container.
- **Triệt Tiêu Hoàn Toàn Tự Suy Diễn Metadata Đóng Dấu (SealedAt Strict Non-Fallback Invariant)**:
  - Trong `createDocument()` của `dataStore.js`, trường `sealedAt` bắt buộc chỉ nhận chuỗi ngày giờ hợp lệ được truyền tường minh khi có đủ thẩm quyền BGH (`docData.verifiedSchoolSeal === true && typeof docData.sealedAt === 'string' && docData.sealedAt.trim()`).
  - CẤM TUYỆT ĐỐI fallback sang `updatedAt`, `createdDate` hoặc `new Date()` trong `sealedAt`, bảo đảm tính trung thực tuyệt đối của dấu thời gian pháp lý nhà trường.
- **Kỷ Luật Không Nuốt Ngoại Lệ (Zero Exception Suppression Law)**:
  - CẤM TUYỆT ĐỐI các khối `catch (e) {}` rỗng hoặc log tượng trưng dạng `[Exception Suppressed]`.
  - Toàn bộ ngoại lệ tại các tầng tích hợp (VAPID, WebPush, Google Drive, Firebase, Zalo) bắt buộc phải ghi nhận cảnh báo có cấu trúc rõ ràng với đầy đủ thông tin ngữ cảnh phục vụ kiểm toán hệ thống.
- **Client Payload Integrity & Fail-Safe UI Error Recovery (handleForwardNewReportDocument)**:
  - Cờ `isRealSchoolSeal` ở client bắt buộc kiểm tra `requiresSeal` (`reportCategory === 'SCHOOL'`), đảm bảo không bao giờ gửi payload đóng dấu cho báo cáo nội bộ `INTERNAL_REPORT` kể cả khi BGH là người ký tự duyệt.
  - Toàn bộ thân hàm `handleForwardNewReportDocument` sau khi khóa controls được bao bọc trong khối `try/catch` toàn năng. Mọi ngoại lệ bất ngờ (DOM, dữ liệu state thiếu, lỗi mạng) đều bắt buộc kích hoạt `resetForwardUIOnError()`, mở khóa controls và đặt lại giao diện an toàn, triệt tiêu 100% tình trạng form bị khóa vĩnh viễn.
- **Client State Machine Bất Biến & Cấm Fallback Vượt Quyền**:
  - Khi bắt đầu gửi hồ sơ, client khóa toàn bộ form điều khiển (`setForwardControlsDisabled(true)`).
  - Khi forward thành công, client tuyệt đối không mở khóa lại form trước khi modal đóng và dữ liệu được làm sạch hoàn tất, ngăn chặn hoàn toàn double submit và stale clicks.
  - Khi máy chủ từ chối yêu cầu (400, 401, 403, 409) hoặc gặp lỗi mạng, client mở khóa controls, reset checkbox self-approval, tải lại danh sách người dùng chuẩn từ server và gọi hàm render canonical duy nhất `populateNextSigners()` để khôi phục trạng thái chuẩn xác, hiển thị thông báo lỗi và tuyệt đối không tự ý fallback ghi đè Firebase.
- **Kiểm Thử Toàn Diện Đa Tiến Trình & Crash Simulation**: Bộ test kiểm thử tự động `test.js` tích hợp kiểm thử đa process thật sự qua `child_process.fork`, mô phỏng crash giữa các bước giao dịch, kiểm tra lock ownership và xác nhận khôi phục dữ liệu hai chiều. Toàn bộ các test cases phải đạt PASS 100%.
- **Transactional Outbox Pre-Commit Law**: Mọi hành vi đồng bộ ngoại vi (Google Drive, Zalo, Notification) bắt buộc phải ghi journal trạng thái `EXTERNAL_SYNC_PENDING` bền vững bằng `fsync` trước khi commit cập nhật dữ liệu tài liệu vào cơ sở dữ liệu. Nếu ghi journal thất bại, giao dịch phải lập tức fail-closed abort và dọn dẹp an toàn.
- **Heavy-Payload DoS before Parser Guard**: Mọi HTTP request `POST/PUT/PATCH` sử dụng `Transfer-Encoding: chunked` hoặc không khai báo `Content-Length` bắt buộc phải chiếm slot trong Heavy-Payload Concurrency Semaphore ngay lập tức tại tầng Socket Stream trước khi gọi `next()` vào `express.json` / parser, triệt tiêu hoàn toàn rủi ro cạn kiệt RAM do buffer luồng dữ liệu trước parser.
- **School Seal Strict Cryptographic Structure Enforcement**: Kiểm định con dấu pháp nhân trường trong `verifySchoolSealArtifact()` bắt buộc phải có cấu trúc chữ ký số điện tử tiêu chuẩn (`/Type /Sig`, `/ByteRange`, `/Filter /Adobe.PPKLite`, `/SubFilter /adbe.pkcs7`) đi kèm danh tính pháp nhân trường hoặc ảnh con dấu định danh kèm chữ ký số. Nghiêm cấm chấp nhận PDF chỉ có ảnh XObject đơn lẻ hoặc text keyword mà thiếu chữ ký số điện tử.
- **Active DB Document Rollback Shield**: Trong quá trình rollback khi tạo hoặc chuyển tiếp hồ sơ (`POST /api/documents/forward`), trước khi xóa tệp `savedFilePath` trên đĩa, hệ thống bắt buộc kiểm tra `isWithinUploadRoot(savedFilePath)` và bảo đảm không có tài liệu DB nào khác đang hoạt động trỏ vào tệp này.
- **DataStore Users Cache Invalidation bằng SHA-256**: Cơ chế nạp danh tính người dùng trong `dataStore.getUsers()` tính toán mã băm SHA-256 nội dung tệp trên đĩa và so sánh `currentHash !== _usersContentHash`, triệt tiêu 100% rủi ro va chạm mtimeMs và fileSize giữa các tiến trình độc lập.
- **BGH-Only Forwarding Law for School Reports**: Khi Tổ trưởng chuyên môn tạo báo cáo cấp trường (`SCHOOL_REPORT`), điểm đến cuối cùng bắt buộc phải là Ban Giám hiệu để ký duyệt và đóng dấu mộc đỏ pháp nhân. Giao diện `populateNextSigners()` tự động lọc danh sách chỉ hiển thị thành viên BGH hợp lệ.
- **Fail-Closed Bearer Token Authentication & Zero Header Identity Spoofing**: Hàm `getCurrentUser(req)` và middleware `requireAuth` triệt tiêu 100% việc nhận diện danh tính qua các HTTP header tự tạo (`x-user-id`, `x-user-username`, `x-user-role`) hoặc `req.body.currentUser`. Mọi yêu cầu tới API bắt buộc phải có Bearer Token hợp lệ do máy chủ phát hành; danh tính người dùng bắt buộc được giải mã từ token và tra cứu fresh từ cơ sở dữ liệu (`dataStore.getUserById(id, true)`). Bất kỳ request nào thiếu token hoặc dùng token giả mạo đều nhận ngay HTTP `401 Unauthorized`.
- **BGH Legal Metadata Privilege Enforcement**: Trong `dataStore.createDocument()`, các trường dữ liệu pháp lý cấp cao `bghApprovedAt` và `bghSigner` chỉ được phép ghi nhận khi phiên làm việc được xác thực chính danh là Ban Giám hiệu (hoặc Quản trị viên) VÀ có cờ xác thực hệ thống `verifiedBghSession === true` (hoặc `verifiedSchoolSeal === true`). Mọi caller khác không đủ thẩm quyền đều bị ép buộc trả về `null` (Fail-Closed Boundary).
- **PAdES Strict Cryptographic Structure Enforcement**: Kiểm định con dấu pháp nhân trường trong `verifySchoolSealArtifact()` bắt buộc phải có đầy đủ cấu trúc chữ ký số PAdES / Adobe.PPKLite: `/Type /Sig`, mảng `/ByteRange [ 0 l1 o2 l2 ]` thỏa mãn `o1 === 0, l1 > 0, o2 > l1, (o2 + l2) <= file.length`, `/Filter` (`/Adobe.PPKLite` hoặc `/ETSI.CAdES`), `/SubFilter` (`/adbe.pkcs7.detached` hoặc `/ETSI.CAdES.detached`), và danh tính pháp nhân trường bắt buộc phải nằm trong Signature Dictionary Context (`/Name`, `/Reason`, `/ContactInfo`) hoặc bên trong khối chứng thư số PKCS#7. Nghiêm cấm chấp nhận text keyword trôi nổi ngoài content stream của trang sách.

## 5. ĐẶC TẢ TẦNG KIẾN TRÚC: cloudflare-worker-router.js [TIER 1 - STATELESS EDGE FAILOVER PROXY]
- **Bản chất**: Bộ định tuyến biên không trạng thái (Stateless Reverse Proxy & Failover Router) triển khai trên nền tảng Cloudflare Workers.
- **Mục tiêu**: Chuyển tiếp HTTP thông minh giữa 2 máy chủ Render dự phòng của trường THCS Chu Văn An:
  + Primary Node: `https://edusign-vgca.onrender.com`
  + Secondary Node: `https://kyso.onrender.com`
- **Thời gian chờ (Timeout)**: 6.000ms (`AbortController`).
- **Cơ chế Failover**:
  + Ưu tiên gửi request đến Primary Node.
  + Nếu Primary Node trả về mã lỗi 502, 503, 504 hoặc gặp ngoại lệ mạng (timeout, fetch error): Tự động chuyển tiếp yêu cầu đến Secondary Node.
  + Nếu cả 2 node đều không phản hồi: Trả về mã lỗi HTTP 503 với JSON `{ error: "Tất cả các máy chủ backend Render đều không khả dụng", status: 503, timestamp: ... }`.
- **Hỗ trợ CORS**: Tự động phản hồi HTTP 204 cho các yêu cầu preflight `OPTIONS` với header `Access-Control-Allow-Origin: *`.
- **An toàn Buffer Payload**: Với các phương thức có body (`POST`, `PUT`, `PATCH`), đọc body dưới dạng `ArrayBuffer` một lần duy nhất trước khi fetch, cho phép tái sử dụng body khi failover sang Secondary Node mà không bị lỗi stream đã bị đọc.
- **NGUYÊN TẮC YAGNI (YOU AREN'T GONNA NEED IT) BẤT BIẾN**:
  + **CẤM TUYỆT ĐỐI** triển khai Durable Objects, cơ chế phân tán ACID, Distributed Lock, Semaphore đa isolate hay HMAC nonces trong tệp này.
  + Mọi cơ chế giao dịch và khóa đã được quản lý ở máy chủ trung tâm (`server.js` và `dataStore.js`). Cloudflare Worker là tầng mạng biên không lưu trữ (Stateless Network Proxy).

## 6. ĐẶC TẢ TẦNG KIẾN TRÚC: pdfSignerService.js [TIER 2 - STANDARD WEB APPLICATION SERVICE]
- **Bản chất**: Dịch vụ tiện ích xử lý tài liệu PDF và chuyển đổi định dạng Docx sang PDF phía máy chủ Node.js/Express.
- **Phạm vi nghiệp vụ**:
  + Chuyển đổi tệp Microsoft Word (.docx/.doc) sang PDF thông qua Word COM (Windows) hoặc LibreOffice (Linux).
  + Thẩm tra con dấu pháp nhân trường (`verifySchoolSealArtifact`) và trích xuất chữ ký số (`extractPdfSignatures`).
  + Đóng dấu mộc đỏ visual (`stampPdfWithSchoolSeal`) và định vị chữ ký trực quan (`addVisualSignatureToPdf`) bằng thư viện `pdf-lib`.
  + Cam kết tệp PDF nguyên tử (`safelyCommitPdfOutput`) với kiểm tra magic bytes `%PDF-`, trailer `%%EOF`, băm SHA-256 đối soát toàn vẹn, và sandbox trong thư mục được cấp phép (`allowedRoots`).
- **NGUYÊN TẮC YAGNI & RANH GIỚI TÍNH NĂNG (TIER 2 STANDARD WEB SERVICE)**:
  + Đây là dịch vụ backend Web tiêu chuẩn phục vụ ký duyệt giáo án học đường.
  + **CẤM TUYỆT ĐỐI** áp đặt các tiêu chuẩn mật mã học phần cứng HSM, FIPS 140-2/3, kernel syscalls chuyên biệt (như `openat2(RESOLVE_BENEATH)`), hoặc yêu cầu native C++ Windows addon đối với tệp này.
  + Kiểm soát bảo mật tập trung vào: xác thực kiểu dữ liệu, sanitize đường dẫn trong `allowedRoots`, kiểm tra symlink phân đoạn, không rò rỉ file descriptor, xử lý lỗi fail-closed và quản lý Promise/async an toàn.

## 7. ĐẶC TẢ TẦNG KIẾN TRÚC: server.js [TIER 2 - STANDARD FULLSTACK WEB APPLICATION]
- **Bản chất**: Máy chủ ứng dụng Web REST API (Node.js/Express) phục vụ hệ thống ký số điện tử THCS Chu Văn An.
- **Phạm vi nghiệp vụ**: Routing API, xác thực Bearer JWT, phân quyền vai trò (BGH, Tổ trưởng, Giáo viên), middleware stream guard chống DoS, tích hợp cơ sở dữ liệu `dataStore.js`, quản lý tệp tin và thông báo.
- **Ranh giới tính năng Thẩm định Cấu trúc Con dấu & Chữ ký số (`hasSchoolSealArtifact` / `verifySchoolSealArtifact`)**:
  + **Bản chất**: Đây là Chốt chặn Kiểm định Cấu trúc sơ bộ (Fast Structural Gatekeeper & ByteRange Integrity Pre-Filter Candidate) mang tên `hasSchoolSealArtifact` (cung cấp alias `verifySchoolSealArtifact` để tương thích ngược) nhằm phát hiện và từ chối các tệp PDF rỗng, text thường hoặc không có con dấu pháp nhân trước khi lưu trữ vào hệ thống:
    1. Trích xuất Signature Dictionary duy nhất (`/Type /Sig`), mảng `/ByteRange [ 0 l1 o2 l2 ]` (`o1 === 0, l1 > 0, o2 >= o1 + l1, (o2 + l2) <= rawBuffer.length`), `/Filter`, `/SubFilter`.
    2. Chống chèn nội dung ngoài ByteRange: không cho phép đối tượng PDF mới (`obj`) xuất hiện sau dải byte đã ký.
    3. Bắt buộc có khối `/Contents` chứa ASN.1 DER SEQUENCE (0x30) và OID PKCS#7 SignedData (`1.2.840.113549.1.7.2`); nếu thiếu hoặc không hợp lệ bắt buộc từ chối false.
    4. Thẩm tra Danh tính Pháp nhân Trường (`legalKeywords`) trong Signature Dictionary (`/Name`, `/Reason`, `/ContactInfo`).
    5. Tính toán và đối soát mã băm SHA-256 trên đúng các dải byte được bảo vệ bởi `ByteRange` (`signedPart1` và `signedPart2`).
    6. CẤM chấp nhận text keyword trôi nổi trong content stream thông thường của trang sách khi thiếu cấu trúc chữ ký số hoặc con dấu.
  + **NGUYÊN TẮC YAGNI & RANH GIỚI TÍNH NĂNG (TIER 2 STANDARD WEB SERVICE)**:
    - `hasSchoolSealArtifact` là tiền kiểm cấu trúc đầu vào tại Web API (Candidate Pre-Filter); tính xác thực mật mã đầy đủ của chứng thư USB Token và Sim SmartCA được đảm bảo bởi hạ tầng ký số VGCA / Ban Cơ yếu Chính phủ hoặc runner RealPdfSigner khi tạo chữ ký.
    - CẤM TUYỆT ĐỐI áp đặt các tiêu chuẩn mật mã học phần cứng HSM của Tier 3 hoặc đòi hỏi giải mã chuỗi tin cậy CA đầy đủ trong hàm tiền kiểm cấu trúc này.
- **NGUYÊN TẮC YAGNI TOÀN CỤC CHO server.js**:
  + Áp dụng đầy đủ tiêu chuẩn Tier 2: an toàn null/undefined, sanitize dữ liệu đầu vào chống SQLi/XSS, quản lý Promise không unhandled rejection, giải phóng tài nguyên.
  + Không áp đặt các tiêu chuẩn mật mã học phần cứng HSM của Tier 3.


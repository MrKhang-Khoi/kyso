/**
 * =========================================================================
 * GOOGLE APPS SCRIPT: TỰ ĐỘNG LƯU TRỮ HỒ SƠ GIÁO ÁN ĐÃ KÝ SỐ VÀO GOOGLE DRIVE
 * Trường THCS Chu Văn An - Xã Đăk Hà - Tỉnh Quảng Ngãi
 * Phiên bản: Chuẩn phân cấp an toàn [Năm học] / [Họ và tên giáo viên] / [Tên_file_DaKy.pdf]
 * =========================================================================
 */

// Cấu hình bảo mật Webhook: BẮT BUỘC thiết lập trong File > Project properties > Script properties:
// - WEBHOOK_SECRET: Khóa bí mật đồng bộ giữa EduSign Server và Google Apps Script (Cấm hardcode)
// - ROOT_FOLDER_NAME: Tên thư mục gốc lưu trữ hồ sơ của trường
var SCRIPT_PROPS = PropertiesService.getScriptProperties();
var WEBHOOK_SECRET = SCRIPT_PROPS.getProperty('WEBHOOK_SECRET');
var ROOT_FOLDER_NAME = SCRIPT_PROPS.getProperty('ROOT_FOLDER_NAME') || 'THCS_CHU_VAN_AN_HOSO_DIENTU';

function doGet(e) {
  return ContentService.createTextOutput(JSON.stringify({
    status: "active",
    school: "TRƯỜNG THCS CHU VĂN AN",
    system: "EduSign Google Drive Storage Webhook",
    timestamp: new Date().toISOString(),
    message: "Webhook Google Drive đang hoạt động sẵn sàng nhận file ký số!"
  })).setMimeType(ContentService.MimeType.JSON);
}

// Hàm chuẩn hóa tên thư mục / tệp chống Path Traversal
function sanitizePathSegment(segment, fallback) {
  if (typeof segment !== 'string' || !segment.trim()) {
    return fallback || 'Chung';
  }
  return segment
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\.\.+/g, '_')
    .trim()
    .slice(0, 100) || (fallback || 'Chung');
}

// Kiểm tra định dạng và tính hợp lệ của email công vụ nhà trường
function isValidOfficialEmail(email) {
  if (typeof email !== 'string') return false;
  var trimmed = email.trim().toLowerCase();
  if (trimmed.length > 254 || trimmed.indexOf('..') !== -1) {
    return false;
  }
  var parts = trimmed.split('@');
  if (parts.length !== 2) return false;
  var user = parts[0];
  var domain = parts[1];

  if (!user || user.length > 64 || !/^[a-zA-Z0-9._%+-]+$/.test(user)) {
    return false;
  }
  if (!domain || domain.indexOf('..') !== -1) {
    return false;
  }

  var labels = domain.split('.');
  if (labels.length < 2) return false;
  for (var i = 0; i < labels.length; i++) {
    var label = labels[i];
    if (!label || label.length > 63 || label.charAt(0) === '-' || label.charAt(label.length - 1) === '-') {
      return false;
    }
    if (!/^[a-zA-Z0-9-]+$/.test(label)) {
      return false;
    }
  }

  // Danh sách domain công vụ được phép (mặc định các domain ngành GD&ĐT)
  var configuredDomains = SCRIPT_PROPS.getProperty('ALLOWED_EMAIL_DOMAINS');
  var allowedList = configuredDomains 
    ? configuredDomains.split(',').map(function(d) { return d.trim().toLowerCase(); }).filter(Boolean)
    : ['thcschuvanan.edu.vn', 'quangngai.edu.vn'];

  return allowedList.indexOf(domain) !== -1;
}

function doPost(e) {
  try {
    // 0. KIỂM TRA CẤU HÌNH MÁY CHỦ SCRIPT PROPERTIES
    if (!WEBHOOK_SECRET || !WEBHOOK_SECRET.trim()) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        message: "Lỗi cấu hình máy chủ: WEBHOOK_SECRET chưa được thiết lập trong Script Properties!"
      })).setMimeType(ContentService.MimeType.JSON);
    }

    if (!e || !e.postData || !e.postData.contents) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        message: "Không nhận được dữ liệu tải lên từ phần mềm!"
      })).setMimeType(ContentService.MimeType.JSON);
    }

    var data;
    try {
      data = JSON.parse(e.postData.contents);
    } catch (jsonErr) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        message: "Dữ liệu payload không phải định dạng JSON hợp lệ: " + jsonErr.message
      })).setMimeType(ContentService.MimeType.JSON);
    }

    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        message: "Cấu trúc dữ liệu không hợp lệ!"
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // 1. XÁC THỰC WEBHOOK SECRET TOKEN (Chống gọi trái phép từ bên ngoài)
    // Chỉ chấp nhận secret từ HTTP header chuyên dụng (X-Webhook-Secret / Authorization Bearer) hoặc từ payload JSON;
    // Tuyệt đối không chấp nhận qua query string / URL parameter nhằm triệt tiêu nguy cơ lộ lọt vào access/proxy logs.
    var headerToken = (e && e.headers) ? (e.headers['x-webhook-secret'] || e.headers['X-Webhook-Secret'] || e.headers['Authorization']) : null;
    if (headerToken && typeof headerToken === 'string' && headerToken.toLowerCase().indexOf('bearer ') === 0) {
      headerToken = headerToken.slice(7).trim();
    }
    var providedToken = headerToken || data.secret_token || data.secretToken || data.webhookSecret;
    if (!providedToken || String(providedToken) !== String(WEBHOOK_SECRET)) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        message: "Từ chối truy cập: Mã bí mật xác thực webhook không hợp lệ hoặc bị thiếu!"
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // ================= ACTION: LẤY HOẶC TẠO THƯ MỤC CỦA GIÁO VIÊN =================
    if (data.action === 'GET_TEACHER_FOLDER') {
      var safeYear = sanitizePathSegment(data.academicYear || data.schoolYear, 'Năm học 2026 - 2027');
      var safeTeacher = sanitizePathSegment(data.teacherName || data.author, 'GiaoVien');
      var teacherFolderSegments = [ROOT_FOLDER_NAME, safeYear, safeTeacher];
      var myFolder = getOrCreateSafeFolderHierarchy(teacherFolderSegments);

      // Webhook chỉ trả về thông tin định danh và liên kết thư mục an toàn;
      // Tuyệt đối không tự động cấp quyền Editor tùy tiện từ payload để triệt tiêu nguy cơ leo thang đặc quyền.
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        folderId: myFolder.getId(),
        folderUrl: myFolder.getUrl(),
        folderPath: teacherFolderSegments.join(' / '),
        teacherName: safeTeacher,
        message: "Lấy thành công thư mục Google Drive của Thầy/Cô!"
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // ================= ACTION: TẢI VÀ LƯU HỒ SƠ ĐÃ KÝ SỐ =================
    var cleanAuthor = sanitizePathSegment(data.author || data.teacherName, 'GiaoVien');
    var cleanYear = sanitizePathSegment(data.schoolYear || data.academicYear, 'Năm học 2026 - 2027');
    var rawFileName = typeof data.fileName === 'string' && data.fileName.trim() ? data.fileName.trim() : ("GiaoAn_DaKy_" + Date.now() + ".pdf");
    var safeFileName = rawFileName.replace(/[/\\?%*:|"<>]/g, '_').replace(/\.\.+/g, '_').trim();
    if (!safeFileName.toLowerCase().endsWith('.pdf')) {
      safeFileName += '.pdf';
    }

    if (!data.fileBase64 || typeof data.fileBase64 !== 'string') {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        message: "Thiếu nội dung file base64 hợp lệ!"
      })).setMimeType(ContentService.MimeType.JSON);
    }

    // Giới hạn kích thước Base64 tối đa (tối đa ~50MB Base64 tương đương 35MB PDF) để chống cạn kiệt bộ nhớ/quota
    var MAX_BASE64_LENGTH = 50 * 1024 * 1024;
    if (data.fileBase64.length > MAX_BASE64_LENGTH) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        message: "Dung lượng dữ liệu Base64 vượt quá giới hạn tối đa cho phép (35MB PDF)!"
      })).setMimeType(ContentService.MimeType.JSON);
    }

    var cleanBase64 = data.fileBase64.replace(/\s+/g, '');
    if (!cleanBase64) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        message: "Nội dung file Base64 không được để trống!"
      })).setMimeType(ContentService.MimeType.JSON);
    }

    if (cleanBase64.length > MAX_BASE64_LENGTH) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        message: "Dung lượng dữ liệu Base64 vượt quá giới hạn tối đa cho phép (35MB PDF)!"
      })).setMimeType(ContentService.MimeType.JSON);
    }

    var fileBytes;
    try {
      if (!/^[A-Za-z0-9+/]+={0,2}$/.test(cleanBase64) || cleanBase64.length % 4 !== 0) {
        throw new Error('Chuỗi Base64 không đúng cấu trúc (độ dài hoặc ký tự không hợp lệ)');
      }
      fileBytes = Utilities.base64Decode(cleanBase64);
    } catch (decodeErr) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        message: "Nội dung file Base64 không hợp lệ: " + decodeErr.message
      })).setMimeType(ContentService.MimeType.JSON);
    }

    if (!fileBytes || fileBytes.length < 500) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        message: "Tệp quá nhỏ hoặc rỗng (" + (fileBytes ? fileBytes.length : 0) + " bytes), từ chối lưu tệp không hợp lệ!"
      })).setMimeType(ContentService.MimeType.JSON);
    }

    var blob = Utilities.newBlob(fileBytes, "application/pdf", safeFileName);

    // 1. Tự động tạo và lấy thư mục phân cấp an toàn trong thư mục gốc của trường
    var folderSegments = [ROOT_FOLDER_NAME, cleanYear, cleanAuthor];
    var targetFolder = getOrCreateSafeFolderHierarchy(folderSegments);

    // 2. DỌN DẸP BẢN CŨ CỦA CHÍNH HỒ SƠ NÀY (ĐỒNG BỘ PHIÊN BẢN CÙNG docId)
    // Chỉ đưa vào thùng rác khi và chỉ khi:
    // a) Tệp là PDF (MIME application/pdf)
    // b) Metadata khớp chính xác mã hồ sơ do EduSign tạo [EDUSIGN_DOC_ID:<safeDocId>]
    // c) Tên tệp khớp chính xác safeFileName
    // Tuyệt đối không xóa theo size < 100 hay xóa tệp khác vô cớ.
    var safeDocId = (data.docId && typeof data.docId === 'string' && data.docId.trim())
      ? sanitizePathSegment(data.docId.trim(), '')
      : '';
    var docMarker = safeDocId ? ("[EDUSIGN_DOC_ID:" + safeDocId + "]") : "";

    if (safeDocId && docMarker) {
      try {
        var filesIterator = targetFolder.getFiles();
        while (filesIterator.hasNext()) {
          var existingFile = filesIterator.next();
          var existingDesc = existingFile.getDescription() || '';
          var existingName = existingFile.getName();
          var existingMime = existingFile.getMimeType();

          var hasMatchingDocId = (
            existingDesc.indexOf(docMarker) !== -1 ||
            existingDesc.indexOf("• Mã hồ sơ: " + safeDocId + "\n") !== -1
          );

          var isExactSameDocVersion = (
            existingMime === 'application/pdf' &&
            existingName === safeFileName &&
            hasMatchingDocId
          );

          if (isExactSameDocVersion) {
            existingFile.setTrashed(true);
          }
        }
      } catch (cleanErr) {
        console.warn("Lỗi dọn tệp cũ:", cleanErr.message);
      }
    }

    // 3. Tạo file PDF đã ký số vào đúng thư mục của giáo viên
    var file = targetFolder.createFile(blob);
    var safeDocTitle = sanitizePathSegment(data.docTitle || data.title, safeFileName);
    var safeDept = sanitizePathSegment(data.department, 'N/A');

    file.setDescription(
      "Hồ sơ giáo án / Báo cáo điện tử đã ký số chuẩn VGCA.\n" +
      (docMarker ? (docMarker + "\n") : "") +
      "• Mã hồ sơ: " + (safeDocId || 'N/A') + "\n" +
      "• Tiêu đề: " + safeDocTitle + "\n" +
      "• Người ký / Tác giả: " + cleanAuthor + "\n" +
      "• Tổ chuyên môn: " + safeDept + "\n" +
      "• Thời gian lưu trữ: " + new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })
    );

    // 4. KIỂM SOÁT PHÂN QUYỀN TRUY CẬP (Mặc định riêng tư PRIVATE, chỉ cấp quyền công khai khi máy chủ được quản trị viên cấu hình)
    if (SCRIPT_PROPS.getProperty('ALLOW_PUBLIC_LINK') === 'true') {
      try {
        file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
      } catch (shareErr) {
        console.warn("Không thể set sharing qua liên kết công khai:", shareErr.message);
      }
    }

    // 5. Tự động chia sẻ quyền xem cho các Thầy/Cô tham gia ký qua Email công vụ hợp lệ
    if (data.signerEmails && Array.isArray(data.signerEmails)) {
      data.signerEmails.forEach(function(em) {
        if (typeof em !== 'string') return;
        var normalizedEmail = em.trim();
        if (!normalizedEmail) return;

        if (isValidOfficialEmail(normalizedEmail)) {
          try {
            file.addViewer(normalizedEmail);
          } catch(e) {
            console.warn("Không thể add viewer email:", normalizedEmail, e.message);
          }
        }
      });
    }

    // 6. Trả về kết quả thành công cho EduSign
    return ContentService.createTextOutput(JSON.stringify({
      success: true,
      fileId: file.getId(),
      fileName: file.getName(),
      viewUrl: file.getUrl(),
      downloadUrl: file.getDownloadUrl(),
      folderPath: folderSegments.join(' / '),
      folderId: targetFolder.getId(),
      uploadedAt: new Date().toISOString(),
      message: "Đã lưu thành công vào thư mục: " + folderSegments.join(' / ')
    })).setMimeType(ContentService.MimeType.JSON);

  } catch (error) {
    console.error("Lỗi xử lý doPost Google Drive:", error);
    return ContentService.createTextOutput(JSON.stringify({
      success: false,
      error: error.toString(),
      message: "Lỗi lưu file trên Google Drive: " + error.message
    })).setMimeType(ContentService.MimeType.JSON);
  }
}

/**
 * Hàm phân cấp thư mục an toàn theo mảng các phân đoạn đã được làm sạch
 * Bắt đầu từ DriveApp.getRootFolder() và tạo/lấy từng cấp tuần tự
 */
function getOrCreateSafeFolderHierarchy(segments) {
  var currentFolder = DriveApp.getRootFolder();
  if (!Array.isArray(segments) || segments.length === 0) {
    return currentFolder;
  }
  for (var i = 0; i < segments.length; i++) {
    var segmentName = sanitizePathSegment(segments[i], 'ThuMuc');
    var folders = currentFolder.getFoldersByName(segmentName);
    if (folders.hasNext()) {
      currentFolder = folders.next();
    } else {
      currentFolder = currentFolder.createFolder(segmentName);
    }
  }
  return currentFolder;
}

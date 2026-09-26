/**
 * ====================================================================================================
 *   🤖 GOOGLE APPS SCRIPT: HỆ THỐNG ZALO BOT HỢP NHẤT TRỢ LÝ TRƯỜNG HỌC 4.0
 *   THỜI KHÓA BIỂU (KÈM KHUNG GIỜ VÀO/RA LỚP) + KÝ SỐ GIÁO ÁN EDUSIGN
 *   Trường THCS Chu Văn An - Xã Đăk Hà - Tỉnh Quảng Ngãi
 * ====================================================================================================
 * Nền tảng: Google Apps Script + Zalo Bot Platform + Google Drive + Google Sheets + Firebase RTDB
 * 
 * CÁC TÍNH NĂNG CHÍNH:
 * 1. 🔔 Thông báo Ký số EduSign 1-1 (Trình ký, Trả về kèm lý do, Ký duyệt hoàn tất đóng dấu).
 * 2. 📱 Liên kết Zalo 0 đồng: Giáo viên chỉ cần gửi Số Điện Thoại -> Tự động ánh xạ Zalo_Chat_ID.
 * 3. ⏰ Khung giờ ra vào lớp chuẩn xác:
 *    - Sáng:  Tiết 1 (07h00-07h45), T2 (07h50-08h35), T3 (08h40-09h25), T4 (09h30-10h15), T5 (10h20-11h05)
 *    - Chiều: Tiết 1 (13h00-13h45), T2 (13h50-14h35), T3 (14h40-15h25), T4 (15h30-16h15), T5 (16h20-17h05)
 * 4. 🌅 TỰ ĐỘNG NHẮN TIN LÚC 6H00 SÁNG: Nhắc lịch giảng dạy chi tiết trong ngày cho từng giáo viên theo SĐT.
 * 5. 📅 Tra cứu TKB thông minh: Lớp học, Giáo viên, Dạy thay, Tìm giáo viên trống tiết, Cổng Web 1-chạm.
 * 6. 📁 Tự động lưu trữ hồ sơ báo cáo giáo án vào Google Drive & Google Sheets.
 * 
 * HƯỚNG DẪN TRIỂN KHAI TRÊN SCRIPT.GOOGLE.COM (CHỈ MẤT 3 PHÚT):
 * 1. Mở dự án trên https://script.google.com -> Dán toàn bộ mã này vào Code.gs.
 * 2. Điền cấu hình ở MỤC 1 bên dưới (CONFIG).
 * 3. Chọn hàm "initSheetsIfMissing" -> Bấm "Chạy" (Run) để tự tạo cấu trúc bảng tính.
 * 4. Chọn hàm "setupDailyMorningTrigger" -> Bấm "Chạy" (Run) để kích hoạt lịch tự động 6h00 sáng.
 * 5. Chọn hàm "setZaloBotWebhook" -> Bấm "Chạy" (Run) để liên kết Webhook với Zalo Bot.
 * 6. Bấm "Triển khai" (Deploy) -> "Bản triển khai mới" (Web App, Thực thi dưới dạng Tôi, Bất kỳ ai truy cập) -> Copy URL.
 */

// ====================================================================================================
// 🌟 1. CẤU HÌNH HỆ THỐNG TOÀN DIỆN
// ====================================================================================================
/**
 * Lấy Token Zalo Bot an toàn từ Script Properties (hoặc biến môi trường), triệt tiêu rủi ro hard-code secret
 */
function getZaloBotToken() {
  var token = "";
  if (typeof PropertiesService !== "undefined" && PropertiesService.getScriptProperties) {
    try {
      var propToken = PropertiesService.getScriptProperties().getProperty("ZALO_BOT_TOKEN");
      if (propToken && propToken.trim()) {
        token = propToken.trim();
      }
    } catch (err) {
      var message = err instanceof Error ? err.message : String(err);
      if (typeof Logger !== "undefined" && Logger.log) {
        Logger.log("⚠️ Không thể đọc ZALO_BOT_TOKEN từ PropertiesService: " + message);
      } else {
        console.error("⚠️ Không thể đọc ZALO_BOT_TOKEN từ PropertiesService:", message);
      }
    }
  }
  if (!token && typeof process !== "undefined" && process.env && process.env.ZALO_BOT_TOKEN) {
    token = process.env.ZALO_BOT_TOKEN.trim();
  }
  if (!token) {
    var warnMsg = "⚠️ ZALO_BOT_TOKEN chưa được cấu hình trong Script Properties (hoặc biến môi trường)!";
    if (typeof Logger !== "undefined" && Logger.log) {
      Logger.log(warnMsg);
    } else {
      console.warn(warnMsg);
    }
  }
  return token;
}

var CONFIG = {
  // Token Zalo Bot Platform (Đọc động bảo mật từ Script Properties, cấm hard-code)
  get ZALO_BOT_TOKEN() {
    return getZaloBotToken();
  },
  
  // ID file Google Sheets làm cơ sở dữ liệu
  SPREADSHEET_ID: "1Y0HQ2Pi-XvtgmOuPqQK-H8Ay5lzVUCh9uzd54Czll2I", 
  
  // URL Web App Google Apps Script công khai đã duyệt quyền Anyone
  WEB_APP_URL: "https://script.google.com/macros/s/AKfycbwGBgauc9xHzRe31_IfCQD-Q9yHwGp4CfYLEam9IupcYhLpNBXbgW0J1t-weD6iUQ87ZQ/exec",

  // Khóa bí mật đồng bộ bảo mật Webhook hệ thống (Mặc định hoặc cấu hình qua Script Properties)
  WEBHOOK_SECRET: "UnifiedZaloBotTHCSCVA2026Secret",

  // Tên trường & Cổng thông tin trực tuyến
  SCHOOL_NAME: "TRƯỜNG THCS CHU VĂN AN",
  PORTAL_URL: "https://mrkhang-khoi.github.io/cvakyso/portal-baocao.html",
  PUBLIC_TKB_PORTAL: "https://mrkhang-khoi.github.io/tkb/",
  
  // Tên các bảng tính trong Google Sheets
  SHEET_USERS: "Danh bạ GV",
  SHEET_REPORTS: "Sổ Lưu Báo Cáo",
  
  // Tên thư mục lưu trữ Báo cáo trên Google Drive
  DRIVE_ROOT_FOLDER: "KHO_BAO_CAO_THCS_CHU_VAN_AN",

  // Kết nối Cơ sở dữ liệu Thời khóa biểu (Firebase Realtime Database)
  FIREBASE_DATABASE_URL: "https://tkb-fet-default-rtdb.asia-southeast1.firebasedatabase.app/school_data.json",

  // ID nhóm Zalo trường nếu muốn gửi bản tin TKB tổng hợp vào nhóm lúc 6h30 sáng (tùy chọn)
  MORNING_BRIEF_CHAT_ID: "",

  // KHUNG GIỜ RA VÀO LỚP CHUẨN XÁC CỦA NHÀ TRƯỜNG (CẤU HÌNH LINH HOẠT)
  PERIOD_TIMES: {
    "sáng": {
      1: "07h00 - 07h45",
      2: "07h50 - 08h35",
      3: "08h40 - 09h25",
      4: "09h30 - 10h15",
      5: "10h20 - 11h05"
    },
    "chiều": {
      1: "13h00 - 13h45",
      2: "13h50 - 14h35",
      3: "14h40 - 15h25",
      4: "15h30 - 16h15",
      5: "16h20 - 17h05"
    }
  },

  // KHUNG GIỜ TOÀN CA HỌC (SÁNG: 07:00 - 11:15, CHIỀU: 12:45 - 17:00)
  SESSION_HOURS: {
    "sáng": "07:00 - 11:15",
    "chiều": "12:45 - 17:00"
  }
};

// ====================================================================================================
// 🔧 2. KHỞI TẠO TỰ ĐỘNG BẢNG TÍNH & CƠ SỞ DỮ LIỆU
// ====================================================================================================
function initSheetsIfMissing() {
  var configuredId =
    typeof CONFIG !== "undefined" &&
    CONFIG &&
    typeof CONFIG.SPREADSHEET_ID === "string"
      ? CONFIG.SPREADSHEET_ID.trim()
      : "";
  if (!configuredId) {
    var missMsg = "❌ CONFIG.SPREADSHEET_ID chưa được cấu hình. Vui lòng thiết lập ID Google Sheet hợp lệ trước khi khởi tạo!";
    Logger.log(missMsg);
    throw new Error(missMsg);
  }
  var ss;
  try {
    ss = SpreadsheetApp.openById(configuredId);
  } catch (e) {
    var errMsg = "❌ Không thể mở Google Sheet với SPREADSHEET_ID đã cấu hình [" + configuredId + "]: " + (e && e.message ? e.message : String(e));
    Logger.log(errMsg);
    throw new Error(errMsg);
  }

  // 1. Khởi tạo Sheet "Danh bạ GV" (Dùng map SĐT -> Zalo Chat ID & TKB ShortName)
  var sheetUsersName =
    typeof CONFIG !== "undefined" &&
    CONFIG &&
    typeof CONFIG.SHEET_USERS === "string" &&
    CONFIG.SHEET_USERS.trim() !== ""
      ? CONFIG.SHEET_USERS.trim()
      : "Danh bạ GV";
  var sheetUsers = ss.getSheetByName(sheetUsersName);
  if (!sheetUsers) {
    sheetUsers = ss.insertSheet(sheetUsersName);
    sheetUsers.getRange(1, 1, 1, 9).setValues([[
      "STT", "Họ và Tên", "Số Điện Thoại", "Tổ Chuyên Môn", "Email Công Vụ", "Zalo_Chat_ID", "Ngày Liên Kết", "Tên_Viết_Tắt_TKB", "Mã PIN"
    ]]);
    sheetUsers.getRange(1, 1, 1, 9).setBackground("#1e40af").setFontColor("#ffffff").setFontWeight("bold");
    sheetUsers.setFrozenRows(1);

    // Định dạng Text thuần túy (@) cho cột C (SĐT), F (Zalo_Chat_ID) và I (Mã PIN) chống mất số 0
    try {
      sheetUsers.getRange("C:C").setNumberFormat("@");
      sheetUsers.getRange("F:F").setNumberFormat("@");
      sheetUsers.getRange("I:I").setNumberFormat("@");
    } catch (eFmt) {
      Logger.log("⚠️ Cảnh báo thiết lập format Text: " + (eFmt && eFmt.message ? eFmt.message : String(eFmt)));
    }
  } else {
    // Tự động kiểm tra và thêm tiêu đề cột 9 "Mã PIN" nếu bảng hiện tại chưa có
    try {
      var headerVal = sheetUsers.getRange(1, 9).getValue();
      if (!headerVal || String(headerVal).trim() === "") {
        sheetUsers.getRange(1, 9).setValue("Mã PIN")
          .setBackground("#1e40af")
          .setFontColor("#ffffff")
          .setFontWeight("bold");
      }
      sheetUsers.getRange("C:C").setNumberFormat("@");
      sheetUsers.getRange("F:F").setNumberFormat("@");
      sheetUsers.getRange("I:I").setNumberFormat("@");
    } catch (eH) {
      Logger.log("⚠️ Lỗi kiểm tra tiêu đề và định dạng cột sheetUsers: " + (eH && eH.message ? eH.message : String(eH)));
      throw new Error("Lỗi cập nhật cấu trúc bảng danh bạ người dùng: " + (eH && eH.message ? eH.message : String(eH)));
    }
  }

  // 2. Khởi tạo Sheet "Sổ Lưu Báo Cáo"
  var sheetReportsName =
    typeof CONFIG !== "undefined" &&
    CONFIG &&
    typeof CONFIG.SHEET_REPORTS === "string" &&
    CONFIG.SHEET_REPORTS.trim() !== ""
      ? CONFIG.SHEET_REPORTS.trim()
      : "Sổ Lưu Báo Cáo";
  var sheetReports = ss.getSheetByName(sheetReportsName);
  if (!sheetReports) {
    sheetReports = ss.insertSheet(sheetReportsName);
    sheetReports.getRange(1, 1, 1, 11).setValues([[
      "Mã Hồ Sơ", "Tiêu Đề Báo Cáo", "Tác GiẢ", "Số Điện Thoại", "Tổ Chuyên Môn",
      "Người Ký BGH", "Ngày Ký Duyệt", "Trạng Thái", "Link Xem Drive", "Link Tải", "Ghi Chú"
    ]]);
    sheetReports.getRange(1, 1, 1, 11).setBackground("#047857").setFontColor("#ffffff").setFontWeight("bold");
    sheetReports.setFrozenRows(1);
  }

  Logger.log("🎉 Khởi tạo bảng dữ liệu hoàn tất!");
  return ss.getId();
}

function getDatabaseSpreadsheet() {
  if (typeof SpreadsheetApp === "undefined") return null;
  var configuredId =
    typeof CONFIG !== "undefined" &&
    CONFIG &&
    typeof CONFIG.SPREADSHEET_ID === "string"
      ? CONFIG.SPREADSHEET_ID.trim()
      : "";
  if (!configuredId) {
    var missErr = "❌ CONFIG.SPREADSHEET_ID chưa được cấu hình. Vui lòng thiết lập ID Google Sheet hợp lệ!";
    Logger.log(missErr);
    throw new Error(missErr);
  }
  try {
    return SpreadsheetApp.openById(configuredId);
  } catch (e) {
    var openErr = "❌ Không thể mở Google Sheet với SPREADSHEET_ID đã cấu hình [" + configuredId + "]: " + (e && e.message ? e.message : String(e));
    Logger.log(openErr);
    throw new Error(openErr);
  }
}

/**
 * Lấy Secret Token bảo vệ Zalo Webhook an toàn từ Script Properties
 */
function getZaloWebhookSecret() {
  var secret = "";
  if (typeof PropertiesService !== "undefined" && PropertiesService.getScriptProperties) {
    try {
      var propSecret = PropertiesService.getScriptProperties().getProperty("ZALO_WEBHOOK_SECRET");
      if (propSecret && propSecret.trim()) {
        secret = propSecret.trim();
      }
    } catch (err) {
      var message = err instanceof Error ? err.message : String(err);
      if (typeof Logger !== "undefined" && Logger.log) {
        Logger.log("⚠️ Không thể đọc ZALO_WEBHOOK_SECRET từ PropertiesService: " + message);
      }
    }
  }
  if (!secret && typeof process !== "undefined" && process.env && process.env.ZALO_WEBHOOK_SECRET) {
    secret = process.env.ZALO_WEBHOOK_SECRET.trim();
  }
  return secret;
}

// ====================================================================================================
// 🚀 3. ĐĂNG KÝ WEBHOOK CHO ZALO BOT (Chạy 1 lần trong Apps Script)
// ====================================================================================================
function setZaloBotWebhook(customUrl) {
  var botToken =
    typeof CONFIG !== "undefined" &&
    CONFIG &&
    typeof CONFIG.ZALO_BOT_TOKEN === "string"
      ? CONFIG.ZALO_BOT_TOKEN.trim()
      : "";

  if (!botToken) {
    var tokenErr = "❌ Vui lòng điền cấu hình ZALO_BOT_TOKEN trong Script Properties hoặc CONFIG!";
    Logger.log(tokenErr);
    return { success: false, reason: "MISSING_ZALO_BOT_TOKEN" };
  }

  var configuredWebAppUrl =
    typeof CONFIG !== "undefined" &&
    CONFIG &&
    typeof CONFIG.WEB_APP_URL === "string"
      ? CONFIG.WEB_APP_URL.trim()
      : "";
  var webAppUrl = customUrl || (configuredWebAppUrl !== "" ? configuredWebAppUrl : "");
  if (!webAppUrl && typeof ScriptApp !== "undefined" && ScriptApp.getService) {
    try {
      webAppUrl = ScriptApp.getService().getUrl() || "";
    } catch (eUrl) {
      webAppUrl = "";
    }
  }

  if (!webAppUrl || typeof webAppUrl !== "string" || !webAppUrl.trim()) {
    var missUrlErr = "❌ Không xác định được URL Web App hợp lệ. Vui lòng cung cấp customUrl hoặc cấu hình CONFIG.WEB_APP_URL!";
    Logger.log(missUrlErr);
    return { success: false, reason: "MISSING_WEB_APP_URL" };
  }

  webAppUrl = webAppUrl.trim();
  // Chống lỗi dùng nhầm link /dev trong trình biên tập Apps Script
  if (webAppUrl.indexOf("/dev") !== -1) {
    webAppUrl = webAppUrl.replace(/\/dev(\?|$)/, "/exec$1");
  }

  // Kiểm tra định dạng URL HTTPS tương thích 100% Google Apps Script V8 (không dùng new URL() vì Apps Script không có class URL toàn cục)
  if (!/^https:\/\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=]+$/i.test(webAppUrl)) {
    var parseErr = "❌ URL Web App bắt buộc sử dụng giao thức HTTPS và đúng định dạng: " + webAppUrl;
    Logger.log(parseErr);
    return { success: false, reason: "INVALID_WEB_APP_URL" };
  }

  var webhookSecret = getZaloWebhookSecret();
  var payload = {
    url: webAppUrl
  };
  if (webhookSecret) {
    payload.secret_token = webhookSecret;
  }

  var apiUrl = "https://bot-api.zaloplatforms.com/bot" + botToken + "/setWebhook";
  var options = {
    method: "post",
    contentType: "application/json",
    payload: JSON.stringify(payload),
    muteHttpExceptions: true
  };

  try {
    var response = UrlFetchApp.fetch(apiUrl, options);
    var statusCode = response ? (typeof response.getResponseCode === "function" ? response.getResponseCode() : 200) : 0;
    var responseText = response ? (typeof response.getContentText === "function" ? response.getContentText() : "") : "";

    if (statusCode >= 200 && statusCode < 300) {
      Logger.log("✅ Đăng ký Webhook thành công với URL [" + webAppUrl + "]: " + responseText);
      return { success: true, statusCode: statusCode, response: responseText };
    } else {
      Logger.log("❌ Đăng ký Webhook thất bại (HTTP " + statusCode + "): " + responseText);
      return { success: false, statusCode: statusCode, error: responseText };
    }
  } catch (err) {
    var errMsg = "❌ Lỗi khi đăng ký Webhook: " + (err && err.message ? err.message : String(err));
    Logger.log(errMsg);
    return { success: false, error: errMsg };
  }
}

// ====================================================================================================
// ⏰ 4. THIẾT LẬP TRIGGER TỰ ĐỘNG GỬI LỊCH DẠY LÚC 6H00 SÁNG & BẢN TIN NHÓM
// ====================================================================================================

/**
 * Dọn dẹp các trigger cũ/trùng lặp để chống hiện tượng gửi tin nhắn lặp lại hoặc spam
 * @param {string} [targetFnName] - Tên hàm cần xóa trigger (nếu không truyền sẽ dọn dẹp các hàm lịch sáng)
 * @return {number} - Số trigger đã xóa
 */
function removeOldTriggers(targetFnName) {
  if (typeof ScriptApp === "undefined" || !ScriptApp.getProjectTriggers) {
    if (typeof Logger !== "undefined") Logger.log("⚠️ ScriptApp không khả dụng trong môi trường hiện tại.");
    return 0;
  }

  var triggers = ScriptApp.getProjectTriggers();
  var removedCount = 0;
  var targetList = targetFnName
    ? [targetFnName]
    : ["sendDailyMorningPersonalSchedule", "sendMorningBriefGroup", "sendDailyMorningBrief"];

  for (var i = 0; i < triggers.length; i++) {
    var trigger = triggers[i];
    var fnName = trigger.getHandlerFunction ? trigger.getHandlerFunction() : "";
    if (targetList.indexOf(fnName) !== -1) {
      try {
        ScriptApp.deleteTrigger(trigger);
        removedCount++;
      } catch (err) {
        if (typeof Logger !== "undefined") Logger.log("⚠️ Lỗi khi xóa trigger: " + err.toString());
      }
    }
  }

  if (typeof Logger !== "undefined") {
    Logger.log("🧹 Đã dọn dẹp " + removedCount + " trigger (" + (targetFnName || "tất cả trigger lịch sáng") + ").");
  }
  return removedCount;
}

/**
 * Cấu hình tự động trigger gửi lịch giảng dạy cá nhân lúc 06:00 - 07:00 sáng hàng ngày
 * Tự động loại bỏ các trigger trùng lặp trước khi thiết lập mới.
 * Tự động loại trừ Chủ Nhật trong logic thực thi của sendDailyMorningPersonalSchedule.
 */
function setupDailyMorningTrigger() {
  if (typeof ScriptApp === "undefined" || !ScriptApp.newTrigger) {
    if (typeof Logger !== "undefined") Logger.log("⚠️ ScriptApp không khả dụng (môi trường ngoài Google Apps Script).");
    return null;
  }

  // 1. Dọn dẹp trigger cũ để chống gửi trùng lặp/spam
  removeOldTriggers("sendDailyMorningPersonalSchedule");
  removeOldTriggers("sendDailyMorningBrief");

  // 2. Tạo trigger mới lúc 06:00 - 07:00 sáng hàng ngày (thời gian chuẩn timeBased của GAS)
  var trigger = ScriptApp.newTrigger("sendDailyMorningPersonalSchedule")
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .create();

  if (typeof Logger !== "undefined") {
    Logger.log("✅ ĐÃ THIẾT LẬP TRIGGER THÀNH CÔNG! Bot sẽ tự động gửi tin nhắn lịch dạy cho giáo viên lúc 06:00 - 07:00 sáng hàng ngày (thứ Hai đến thứ Bảy, trừ Chủ Nhật).");
  }
  return trigger;
}

/**
 * Lấy chat ID nhóm bản tin sáng ưu tiên từ PropertiesService, fallback sang CONFIG
 * @return {string}
 */
function getMorningBriefChatId() {
  var chatId = "";
  if (typeof PropertiesService !== "undefined" && PropertiesService.getScriptProperties) {
    try {
      chatId = PropertiesService.getScriptProperties().getProperty("MORNING_BRIEF_CHAT_ID") || "";
    } catch (e) {
      if (typeof Logger !== "undefined") {
        Logger.log("Không thể đọc MORNING_BRIEF_CHAT_ID từ ScriptProperties: " + (e && e.message ? e.message : e));
      }
    }
  }
  if (!chatId && typeof CONFIG !== "undefined" && CONFIG && CONFIG.MORNING_BRIEF_CHAT_ID) {
    chatId = CONFIG.MORNING_BRIEF_CHAT_ID;
  }
  return String(chatId || "").trim();
}

/**
 * Xác thực API Key của Quản trị viên cho các tác vụ nhạy cảm
 * @param {string} providedKey
 * @return {boolean}
 */
function verifyAdminApiKey(providedKey) {
  var expectedKey = "";
  if (typeof PropertiesService !== "undefined" && PropertiesService.getScriptProperties) {
    try {
      expectedKey = PropertiesService.getScriptProperties().getProperty("ADMIN_API_KEY") || "";
    } catch (e) {
      if (typeof Logger !== "undefined") {
        Logger.log("Không thể đọc ADMIN_API_KEY từ ScriptProperties: " + (e && e.message ? e.message : e));
      }
    }
  }
  if (!expectedKey && typeof process !== "undefined" && process && process.env) {
    expectedKey = process.env.ADMIN_API_KEY || "";
  }
  if (!expectedKey && typeof CONFIG !== "undefined" && CONFIG && CONFIG.ADMIN_API_KEY) {
    expectedKey = CONFIG.ADMIN_API_KEY;
  }
  if (!expectedKey) return false;
  return typeof providedKey === "string" && providedKey.length > 0 && providedKey === expectedKey;
}

/**
 * Cấu hình tự động trigger gửi bản tin TKB tổng hợp toàn trường vào nhóm Zalo chung
 * Khung giờ thực thi: 06:00 - 07:00 sáng (mục tiêu ~06:30 AM)
 * Chỉ kích hoạt khi MORNING_BRIEF_CHAT_ID hoặc targetChatId được cấu hình
 * @param {string} [targetChatId] - Chat ID nhóm Zalo (mặc định lấy CONFIG.MORNING_BRIEF_CHAT_ID)
 * @return {object} - Trạng thái cấu hình trigger
 */
function setupMorningBriefGroupTrigger(targetChatId) {
  var configuredChatId = "";
  if (typeof CONFIG !== "undefined" && CONFIG) {
    configuredChatId = CONFIG.MORNING_BRIEF_CHAT_ID || "";
  }
  var resolvedId = targetChatId || getMorningBriefChatId() || configuredChatId || "";
  var chatId = String(resolvedId).trim();
  if (!chatId) {
    if (typeof Logger !== "undefined") {
      Logger.log("⚠️ Chưa cấu hình CONFIG.MORNING_BRIEF_CHAT_ID hoặc chat ID nhóm. Vui lòng cấu hình ID nhóm Zalo trường trước khi kích hoạt trigger này.");
    }
    return { success: false, error: "MISSING_GROUP_CHAT_ID" };
  }

  // Persist chatId vào PropertiesService để trigger nền độc lập có thể đọc chính xác
  if (typeof PropertiesService !== "undefined" && PropertiesService.getScriptProperties) {
    try {
      PropertiesService.getScriptProperties().setProperty("MORNING_BRIEF_CHAT_ID", chatId);
    } catch (e) {
      if (typeof Logger !== "undefined") {
        Logger.log("⚠️ Không thể lưu MORNING_BRIEF_CHAT_ID vào ScriptProperties: " + (e && e.message ? e.message : e));
      }
    }
  }

  if (typeof ScriptApp === "undefined" || !ScriptApp.newTrigger) {
    if (typeof Logger !== "undefined") Logger.log("⚠️ ScriptApp không khả dụng (môi trường ngoài Google Apps Script).");
    return { success: false, error: "NO_SCRIPT_APP" };
  }

  // 1. Dọn dẹp trigger cũ
  removeOldTriggers("sendMorningBriefGroup");
  removeOldTriggers("sendDailyMorningBrief");

  // 2. Tạo trigger thời gian lúc 06:00 - 07:00 sáng (~06:30 AM)
  var trigger = ScriptApp.newTrigger("sendMorningBriefGroup")
    .timeBased()
    .everyDays(1)
    .atHour(6)
    .create();

  if (typeof Logger !== "undefined") {
    Logger.log("✅ ĐÃ THIẾT LẬP TRIGGER BẢN TIN NHÓM THÀNH CÔNG! Bot sẽ tự động gửi bản tin TKB tổng hợp tới nhóm (" + chatId + ") lúc 06:00 - 07:00 sáng hàng ngày.");
  }
  return { success: true, trigger: trigger, chatId: chatId };
}

// ====================================================================================================
// 🌐 5. XỬ LÝ GET (Cổng Tra Cứu Báo Cáo & API Trực Tuyến)
// ====================================================================================================
function doGet(e) {
  var params = (e && e.parameter) ? e.parameter : {};
  var action = params.action || "PING";

  // A. API phục vụ Cổng Tra Cứu Báo Cáo Độc Lập
  if (action === "GET_REPORTS" || action === "PORTAL_REPORTS") {
    try {
      // Xác thực tùy chọn nếu hệ thống yêu cầu PORTAL_ACCESS_TOKEN
      var configuredPortalToken = "";
      if (typeof PropertiesService !== "undefined" && PropertiesService.getScriptProperties) {
        try {
          configuredPortalToken = PropertiesService.getScriptProperties().getProperty("PORTAL_ACCESS_TOKEN") || "";
        } catch (e) {
          if (typeof Logger !== "undefined") {
            Logger.log("⚠️ Không thể đọc PORTAL_ACCESS_TOKEN từ ScriptProperties: " + (e && e.message ? e.message : e));
          }
          return ContentService.createTextOutput(JSON.stringify({
            success: false,
            error: "CONFIGURATION_ERROR"
          })).setMimeType(ContentService.MimeType.JSON);
        }
      }
      if (!configuredPortalToken && typeof CONFIG !== "undefined" && CONFIG && CONFIG.PORTAL_ACCESS_TOKEN) {
        configuredPortalToken = CONFIG.PORTAL_ACCESS_TOKEN;
      }
      if (configuredPortalToken) {
        // Kiểm tra khả năng hỗ trợ header của môi trường; nếu thiếu e.headers trả lỗi cấu hình rõ ràng
        if (!e || !e.headers) {
          return ContentService.createTextOutput(JSON.stringify({
            success: false,
            error: "CONFIGURATION_ERROR"
          })).setMimeType(ContentService.MimeType.JSON);
        }
        var authHdr = e.headers["Authorization"] || e.headers["authorization"] || "";
        var providedToken = (authHdr.indexOf("Bearer ") === 0) ? authHdr.substring(7).trim() : (e.headers["X-Portal-Token"] || e.headers["x-portal-token"] || "");
        if (!providedToken || providedToken !== configuredPortalToken) {
          return ContentService.createTextOutput(JSON.stringify({
            success: false,
            error: "UNAUTHORIZED_PORTAL_ACCESS"
          })).setMimeType(ContentService.MimeType.JSON);
        }
      }

      var reports = fetchReportsFromSheet(params);
      var schoolName = (typeof CONFIG !== "undefined" && CONFIG && CONFIG.SCHOOL_NAME) ? CONFIG.SCHOOL_NAME : "EduSign Portal";
      return ContentService.createTextOutput(JSON.stringify({
        success: true,
        school: schoolName,
        total: reports.total,
        page: reports.page,
        limit: reports.limit,
        data: reports.data
      })).setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
      if (typeof Logger !== "undefined") Logger.log("⚠️ Lỗi truy vấn báo cáo trong doGet: " + (err && err.message ? err.message : err));
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        error: "REPORTS_UNAVAILABLE"
      })).setMimeType(ContentService.MimeType.JSON);
    }
  }

  if (action === "DELETE_REPORT") {
    // Kiểm tra khả năng hỗ trợ header của môi trường; cấm query param credential
    if (!e || !e.headers) {
      return ContentService.createTextOutput(JSON.stringify({ success: false, error: "METHOD_NOT_ALLOWED" })).setMimeType(ContentService.MimeType.JSON);
    }
    var reqAdminKey = ((e.headers["Authorization"] || e.headers["authorization"] || "").replace(/^Bearer\s+/i, "") || e.headers["X-Admin-Key"] || e.headers["x-admin-key"] || "").trim();
    if (!reqAdminKey || !verifyAdminApiKey(reqAdminKey)) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        error: "UNAUTHORIZED_ADMIN_ACTION"
      })).setMimeType(ContentService.MimeType.JSON);
    }
    try {
      var delResult = deleteReportFromSheet(params.docId, reqAdminKey);
      return ContentService.createTextOutput(JSON.stringify(delResult)).setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
      if (typeof Logger !== "undefined") Logger.log("⚠️ Lỗi DELETE_REPORT: " + (err && err.message ? err.message : err));
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        error: "OPERATION_FAILED"
      })).setMimeType(ContentService.MimeType.JSON);
    }
  }

  if (action === "BATCH_DELETE_REPORTS") {
    if (!verifyAdminApiKey(params.adminKey || params.apiKey || params.key)) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        error: "UNAUTHORIZED_ADMIN_ACTION"
      })).setMimeType(ContentService.MimeType.JSON);
    }

    var docIdsRaw = params.docIds;
    var docIdsList = [];
    if (Array.isArray(docIdsRaw)) {
      docIdsList = docIdsRaw
        .filter(function(id) { return typeof id === "string"; })
        .map(function(id) { return id.trim(); })
        .filter(Boolean);
    } else if (typeof docIdsRaw === "string") {
      docIdsList = docIdsRaw
        .split(",")
        .map(function(id) { return id.trim(); })
        .filter(Boolean);
    } else if (docIdsRaw != null) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        error: "INVALID_DOC_IDS"
      })).setMimeType(ContentService.MimeType.JSON);
    }

    if (docIdsList.length === 0) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        error: "EMPTY_DOC_IDS"
      })).setMimeType(ContentService.MimeType.JSON);
    }

    try {
      var batchResult = batchDeleteReportsFromSheet(docIdsList);
      return ContentService.createTextOutput(JSON.stringify(batchResult)).setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
      if (typeof Logger !== "undefined") Logger.log("⚠️ Lỗi BATCH_DELETE_REPORTS: " + (err && err.message ? err.message : err));
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        error: "OPERATION_FAILED"
      })).setMimeType(ContentService.MimeType.JSON);
    }
  }

  if (action === "CLEAR_ALL_REPORTS") {
    if (!verifyAdminApiKey(params.adminKey || params.apiKey || params.key)) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        error: "UNAUTHORIZED_ADMIN_ACTION"
      })).setMimeType(ContentService.MimeType.JSON);
    }
    try {
      var clearResult = clearAllReportsFromSheet();
      return ContentService.createTextOutput(JSON.stringify(clearResult)).setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
      if (typeof Logger !== "undefined") Logger.log("⚠️ Lỗi CLEAR_ALL_REPORTS: " + (err && err.message ? err.message : err));
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        error: "OPERATION_FAILED"
      })).setMimeType(ContentService.MimeType.JSON);
    }
  }

  // B. Tra cứu TKB nhanh qua đường dẫn URL (?query=tkb 6a1 hoặc ?action=TEST_TOMORROW)
  var query = params.query || params.text || "";
  var chatId = params.chat_id || params.chatId || "";

  if (action === "TEST_TOMORROW" || action === "TEST_SCHEDULE") {
    if (!verifyAdminApiKey(params.adminKey || params.apiKey || params.key)) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        error: "UNAUTHORIZED_ADMIN_ACTION"
      })).setMimeType(ContentService.MimeType.JSON);
    }
    var rawPhone = params.phone != null ? String(params.phone).trim() : "0818810007";
    var phoneRegex = /^0\d{9}$/;
    if (!phoneRegex.test(rawPhone)) {
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        error: "INVALID_PHONE_NUMBER"
      })).setMimeType(ContentService.MimeType.JSON);
    }

    try {
      var testResult = testSendTomorrowSchedule(rawPhone);
      return ContentService.createTextOutput(JSON.stringify(testResult, null, 2)).setMimeType(ContentService.MimeType.JSON);
    } catch (err) {
      if (typeof Logger !== "undefined") Logger.log("⚠️ Lỗi TEST_TOMORROW: " + (err && err.message ? err.message : err));
      return ContentService.createTextOutput(JSON.stringify({
        success: false,
        error: "OPERATION_FAILED"
      })).setMimeType(ContentService.MimeType.JSON);
    }
  }

  if (query) {
    try {
      var responseText = processUnifiedZaloMessage(chatId, query);
      return ContentService.createTextOutput(responseText).setMimeType(ContentService.MimeType.TEXT);
    } catch (err) {
      if (typeof Logger !== "undefined") Logger.log("⚠️ Lỗi processUnifiedZaloMessage: " + (err && err.message ? err.message : err));
      return ContentService.createTextOutput("Xin lỗi, hệ thống đang bận. Vui lòng thử lại sau.").setMimeType(ContentService.MimeType.TEXT);
    }
  }

  // C. Health Check
  var healthSchoolName = (typeof CONFIG !== "undefined" && CONFIG && CONFIG.SCHOOL_NAME) ? CONFIG.SCHOOL_NAME : "EduSign Portal";
  return ContentService.createTextOutput(JSON.stringify({
    status: "active",
    system: "Unified Zalo Assistant 4.0 (Timetable + EduSign)",
    school: healthSchoolName,
    timestamp: new Date().toISOString(),
    guide: "Webhook sẵn sàng phục vụ Tra cứu Thời khóa biểu và Ký số."
  })).setMimeType(ContentService.MimeType.JSON);
}

/**
 * Lấy Webhook Secret dùng chung từ Script Properties hoặc process.env
 * @return {string}
 */
function getSystemWebhookSecret() {
  var secret = "";
  if (typeof PropertiesService !== "undefined" && PropertiesService.getScriptProperties) {
    try {
      secret = PropertiesService.getScriptProperties().getProperty("WEBHOOK_SECRET") || "";
    } catch (e) {
      if (typeof Logger !== "undefined") {
        Logger.log("⚠️ Không thể đọc WEBHOOK_SECRET từ PropertiesService: " + (e && e.message ? e.message : e));
      }
    }
  }
  if (!secret && typeof process !== "undefined" && process && process.env) {
    secret = process.env.WEBHOOK_SECRET || "";
  }
  if (!secret && typeof CONFIG !== "undefined" && CONFIG && CONFIG.WEBHOOK_SECRET) {
    secret = CONFIG.WEBHOOK_SECRET;
  }
  return String(secret || "").trim();
}

// ====================================================================================================
// 📩 6. XỬ LÝ POST (TIẾP NHẬN WEBHOOK TỪ SERVER KÝ SỐ VÀ TỪ ZALO BOT)
// ====================================================================================================
function doPost(e) {
  try {
    var postData = {};
    if (e && e.postData && typeof e.postData.contents === "string" && e.postData.contents.trim() !== "") {
      try {
        var parsed = JSON.parse(e.postData.contents);
        if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
          postData = parsed;
        } else {
          return ContentService.createTextOutput(JSON.stringify({
            success: false,
            error: "INVALID_JSON_PAYLOAD"
          })).setMimeType(ContentService.MimeType.JSON);
        }
      } catch (err) {
        if (typeof Logger !== "undefined") {
          Logger.log("⚠️ Lỗi phân tích JSON payload trong doPost: " + (err && err.message ? err.message : err));
        }
        return ContentService.createTextOutput(JSON.stringify({
          success: false,
          error: "INVALID_JSON_PAYLOAD"
        })).setMimeType(ContentService.MimeType.JSON);
      }
    } else if (e && e.parameter && typeof e.parameter === "object" && !Array.isArray(e.parameter)) {
      postData = e.parameter;
    }

    if (!postData || typeof postData !== "object" || Array.isArray(postData)) {
      postData = {};
    }

    var action = postData.action || "";

    // Kiểm tra chữ ký bảo mật Webhook Secret Token từ cấu hình ScriptProperties/env (chỉ nhận từ payload POST body)
    var providedSecret = String(postData.secret_token || "").trim();
    var SYSTEM_SECRET = getSystemWebhookSecret();

    // Danh sách các hành động nhạy cảm bắt buộc phải có secret_token
    var sensitiveActions = [
      "DELETE_REPORT",
      "BATCH_DELETE_REPORTS",
      "CLEAR_ALL_REPORTS",
      "NOTIFY_SIGN_EVENT",
      "SYNC_TEACHER",
      "SYNC_TEACHERS_BATCH",
      "UPLOAD_SIGNED_DOC",
      "ARCHIVE_REPORT"
    ];

    if (sensitiveActions.indexOf(action) !== -1) {
      if (!SYSTEM_SECRET || !providedSecret || providedSecret !== SYSTEM_SECRET) {
        if (typeof Logger !== "undefined") {
          Logger.log("⛔ Cảnh báo: Truy cập trái phép doPost không có secret_token hợp lệ cho action: " + action);
        }
        return ContentService.createTextOutput(JSON.stringify({ 
          success: false, 
          error: "UNAUTHORIZED_SECRET_TOKEN" 
        })).setMimeType(ContentService.MimeType.JSON);
      }
    }

    // ----------------------------------------------------------------------------------
    // NHÁNH 1: NHẬN LỆNH TỪ SERVER KÝ SỐ EDUSIGN & ĐỒNG BỘ GIÁO VIÊN
    // ----------------------------------------------------------------------------------
    if (action === "SYNC_TEACHER") {
      var syncResult = handleSyncTeacher(postData);
      return ContentService.createTextOutput(JSON.stringify(syncResult)).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === "SYNC_TEACHERS_BATCH") {
      var batchSyncResult = handleSyncTeachersBatch(postData);
      return ContentService.createTextOutput(JSON.stringify(batchSyncResult)).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === "NOTIFY_SIGN_EVENT") {
      var eventResult = handleEduSignNotification(postData);
      return ContentService.createTextOutput(JSON.stringify(eventResult)).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === "UPLOAD_SIGNED_DOC" || action === "ARCHIVE_REPORT") {
      var archiveResult = handleReportArchive(postData);
      return ContentService.createTextOutput(JSON.stringify(archiveResult)).setMimeType(ContentService.MimeType.JSON);
    }

    if (action === "DELETE_REPORT") {
      var delDocId = String(
        postData.docId ||
        (postData.parameter && postData.parameter.docId) ||
        ""
      ).trim();

      if (!delDocId) {
        return ContentService.createTextOutput(JSON.stringify({
          success: false,
          error: "INVALID_DOC_ID"
        })).setMimeType(ContentService.MimeType.JSON);
      }

      try {
        var delResult = deleteReportFromSheet(delDocId);
        return ContentService.createTextOutput(JSON.stringify(delResult)).setMimeType(ContentService.MimeType.JSON);
      } catch (err) {
        if (typeof Logger !== "undefined") Logger.log("⚠️ Lỗi DELETE_REPORT trong doPost: " + (err && err.message ? err.message : err));
        return ContentService.createTextOutput(JSON.stringify({
          success: false,
          error: "OPERATION_FAILED"
        })).setMimeType(ContentService.MimeType.JSON);
      }
    }

    if (action === "BATCH_DELETE_REPORTS") {
      var docIds = postData.docIds || (postData.parameter && postData.parameter.docIds);
      var docIdsList = [];
      if (Array.isArray(docIds)) {
        docIdsList = docIds
          .filter(function(id) { return typeof id === "string"; })
          .map(function(id) { return id.trim(); })
          .filter(Boolean);
      } else if (typeof docIds === "string") {
        docIdsList = docIds
          .split(",")
          .map(function(id) { return id.trim(); })
          .filter(Boolean);
      } else if (docIds != null) {
        return ContentService.createTextOutput(JSON.stringify({
          success: false,
          error: "INVALID_DOC_IDS"
        })).setMimeType(ContentService.MimeType.JSON);
      }

      if (docIdsList.length === 0) {
        return ContentService.createTextOutput(JSON.stringify({
          success: false,
          error: "EMPTY_DOC_IDS"
        })).setMimeType(ContentService.MimeType.JSON);
      }

      try {
        var batchResult = batchDeleteReportsFromSheet(docIdsList);
        return ContentService.createTextOutput(JSON.stringify(batchResult)).setMimeType(ContentService.MimeType.JSON);
      } catch (err) {
        if (typeof Logger !== "undefined") Logger.log("⚠️ Lỗi BATCH_DELETE_REPORTS trong doPost: " + (err && err.message ? err.message : err));
        return ContentService.createTextOutput(JSON.stringify({
          success: false,
          error: "OPERATION_FAILED"
        })).setMimeType(ContentService.MimeType.JSON);
      }
    }

    if (action === "CLEAR_ALL_REPORTS") {
      try {
        var clearResult = clearAllReportsFromSheet();
        return ContentService.createTextOutput(JSON.stringify(clearResult)).setMimeType(ContentService.MimeType.JSON);
      } catch (err) {
        if (typeof Logger !== "undefined") Logger.log("⚠️ Lỗi CLEAR_ALL_REPORTS trong doPost: " + (err && err.message ? err.message : err));
        return ContentService.createTextOutput(JSON.stringify({
          success: false,
          error: "OPERATION_FAILED"
        })).setMimeType(ContentService.MimeType.JSON);
      }
    }

    // ----------------------------------------------------------------------------------
    // NHÁNH 2: NHẬN TIN NHẮN TỪ ZALO BOT (GIÁO VIÊN / HỌC SINH TƯƠNG TÁC)
    // ----------------------------------------------------------------------------------
    var userMessage = "";
    var chatId = "";
    var eventName = postData.event_name || "";

    if (postData.message) {
      userMessage = postData.message.text || "";
      if (!userMessage && postData.message.attachments && postData.message.attachments.length > 0) {
        for (var a = 0; a < postData.message.attachments.length; a++) {
          var item = postData.message.attachments[a];
          if (item && item.payload && item.payload.phone_number) {
            userMessage = item.payload.phone_number;
            break;
          }
        }
      }
      if (!userMessage && postData.message.contact && postData.message.contact.phone_number) {
        userMessage = postData.message.contact.phone_number;
      }
      if (postData.message.chat) {
        chatId = postData.message.chat.id;
      } else if (postData.message.from) {
        chatId = postData.message.from.id;
      }
    } else if (postData.text) {
      userMessage = postData.text;
      chatId = postData.chat_id || postData.sender_id || postData.user_id;
    } else if (eventName === "user_send_text") {
      userMessage = postData.message ? (typeof postData.message === "string" ? postData.message : (postData.message.text || "")) : "";
      chatId = postData.sender ? (typeof postData.sender === "object" ? postData.sender.id : postData.sender) : "";
    }

    if (!chatId && postData.chat_id) chatId = postData.chat_id;
    if (!chatId && postData.sender) chatId = (typeof postData.sender === "object" ? postData.sender.id : postData.sender);
    if (!chatId && postData.user_id) chatId = postData.user_id;
    if (!chatId && postData.from) chatId = (typeof postData.from === "object" ? postData.from.id : postData.from);

    // Khi người dùng vừa mở bot hoặc gửi lệnh /start
    if (eventName === "follow" || eventName === "user_open_bot" || eventName === "join" || userMessage === "/start") {
      var welcomeMsg = getUnifiedWelcomeGuideText();
      if (chatId) sendZaloBotReply(chatId, welcomeMsg);
      return ContentService.createTextOutput(JSON.stringify({ status: "welcome_sent" })).setMimeType(ContentService.MimeType.JSON);
    }

    // Xử lý nội dung tin nhắn và phản hồi
    if (userMessage || chatId) {
      var replyText = processUnifiedZaloMessage(chatId, userMessage);
      if (replyText && chatId) {
        sendZaloBotReply(chatId, replyText);
        return ContentService.createTextOutput(JSON.stringify({ status: "success", reply: replyText })).setMimeType(ContentService.MimeType.JSON);
      }
    }

    return ContentService.createTextOutput(JSON.stringify({ status: "ignored" })).setMimeType(ContentService.MimeType.JSON);

  } catch (err) {
    if (typeof Logger !== "undefined") {
      Logger.log("⚠️ Lỗi doPost: " + (err && err.message ? err.message : err));
    }
    return ContentService.createTextOutput(JSON.stringify({ status: "error", error: "SERVER_ERROR" })).setMimeType(ContentService.MimeType.JSON);
  }
}

// ====================================================================================================
// 🧠 7. BỘ ĐIỀU PHỐI TIN NHẮN THÔNG MINH HỢP NHẤT (UNIFIED NLP ROUTER)
// ====================================================================================================
function processUnifiedZaloMessage(chatId, rawText) {
  var text = typeof rawText === "string" ? rawText.trim() : "";
  if (!text) return getUnifiedWelcomeGuideText();

  var clean = removeVietnameseTones(text).toLowerCase();

  // ----------------------------------------------------------------------------
  // 1. LIÊN KẾT TÀI KHOẢN QUA SỐ ĐIỆN THOẠI (Dành cho Giáo viên)
  // ----------------------------------------------------------------------------
  // Khắc phục DEFECT-ZALO-04: Bắt buộc cú pháp LK <SĐT> <PIN> để ngăn chặn Account Takeover (hỗ trợ PIN 1-8 ký tự, hỗ trợ SĐT có định dạng)
  var linkPattern = text.match(/^(LK|LIENKET)\s+([\+0-9\s\-\.\(\)]{9,25})\s+([0-9A-Za-z]{1,8})$/i);
  if (linkPattern) {
    if (chatId) {
      return handleSecurePhoneMapping(chatId, linkPattern[2].trim(), linkPattern[3].trim());
    }
    return "⚠️ Thiếu định danh người dùng Zalo (chatId).";
  }

  // Nếu người dùng chỉ gõ trơ trọi số điện thoại, hướng dẫn bảo mật định danh
  var rawDigits = text.replace(/[^0-9]/g, "");
  if (rawDigits.length >= 9 && rawDigits.length <= 12 && !clean.startsWith("tkb") && !clean.startsWith("lop")) {
    var normRaw = normalizePhone(rawDigits);
    return "🔐 BẢO VỆ ĐỊNH DANH GIÁO VIÊN:\n\n" +
           "Để bảo vệ quyền riêng tư hồ sơ giáo án, Thầy/Cô vui lòng nhắn cú pháp kèm Mã PIN EduSign cá nhân:\n" +
           "👉 Cú pháp: LK " + normRaw + " [MãPIN]\n\n" +
           "📌 Thầy/Cô xem Mã PIN tại mục 'Thông tin cá nhân & Zalo' trên trang web EduSign của trường.";
  }

  // ----------------------------------------------------------------------------
  // 1.1 TRA CỨU HỒ SƠ THEO MÃ ĐỊNH DANH (KHBD, BC, GA, HOSO) - DEFECT-ZALO-02
  // ----------------------------------------------------------------------------
  var docIdMatch = text.match(/^(KHBD|BC|GA|HOSO)[-_0-9A-Za-z]+/i);
  if (docIdMatch) {
    return handleLookupSpecificDocument(chatId, docIdMatch[0].toUpperCase());
  }

  // ----------------------------------------------------------------------------
  // 1.2 TRA CỨU DANH SÁCH HỒ SƠ CHỜ DUYỆT (choduyet, pending) - DEFECT-ZALO-03
  // ----------------------------------------------------------------------------
  if (clean === "choduyet" || clean === "cho duyet" || clean === "pending" || clean === "choky" || clean === "cho ky" || clean === "danh sach cho duyet") {
    return handleLookupPendingDocuments(chatId);
  }

  // ----------------------------------------------------------------------------
  // 2. CÁC LỆNH KÝ SỐ & HỒ SƠ BÁO CÁO CHUYÊN MÔN
  // ----------------------------------------------------------------------------
  if (clean === "hoso" || clean === "ho so" || clean === "trangthai" || clean === "trang thai" || clean === "kiemtra") {
    return handleLookupTeacherReports(chatId);
  }

  if (clean === "baocao" || clean === "bao cao" || clean === "kho" || clean === "drive") {
    return "🌐 CỔNG TRA CỨU BÁO CÁO ĐIỆN TỬ - THCS CHU VĂN AN:\n" +
           "Thầy/Cô bấm vào liên kết bên dưới để tra cứu toàn bộ báo cáo chuyên môn đã được ký duyệt & đóng dấu:\n👉 " + CONFIG.PORTAL_URL;
  }

  if (clean === "huylienket" || clean === "huy lien ket") {
    return handleUnlinkPhone(chatId);
  }

  // ----------------------------------------------------------------------------
  // 3. TRỢ GIÚP / MENU HƯỚNG DẪN
  // ----------------------------------------------------------------------------
  if (clean === "help" || clean === "menu" || clean === "tro giup" || clean === "huong dan" || clean === "?" || clean === "chao" || clean === "xin chao" || clean === "hi" || clean === "hello") {
    return getUnifiedWelcomeGuideText();
  }

  // ----------------------------------------------------------------------------
  // 4. TIỆN ÍCH TKB CÁ NHÂN HÓA 1-CHẠM (Dành cho Giáo viên đã liên kết SĐT)
  // ----------------------------------------------------------------------------
  var isPersonalTkb = (
    clean === "tkb" || clean === "tkb hom nay" || clean === "tkb hn" ||
    clean === "tkb mai" || clean === "tkb ngay mai" || clean === "lich mai" ||
    clean === "lich ngay mai" || clean === "nhac lich" || clean === "lich day" ||
    clean === "mai" || clean === "hom nay"
  );
  if (chatId && isPersonalTkb) {
    var teacherProfile = getTeacherProfileByChatId(chatId);
    if (teacherProfile && teacherProfile.fullName) {
      var schoolData = fetchSchoolTimetableData();
      if (schoolData) {
        var matchedTeacher = findMatchingTeacher(teacherProfile.shortName || teacherProfile.fullName, schoolData.teachers || []);
        if (matchedTeacher) {
          var isTomorrow = (clean.indexOf("mai") !== -1);
          if (isTomorrow) {
            return generateTomorrowTeacherMessage(matchedTeacher, schoolData);
          }
          var dayKey = parseDayFilter(clean);
          return formatTeacherTimetableResponse(matchedTeacher, schoolData, dayKey);
        }
      }
    }
  }

  // ----------------------------------------------------------------------------
  // 5. TRA CỨU LỊCH DẠY THAY & ĐỔI TIẾT
  // ----------------------------------------------------------------------------
  if (clean.includes("day thay") || clean.includes("hoc thay") || clean.includes("doi tiet") || clean.includes("lich thay")) {
    var schoolData = fetchSchoolTimetableData();
    return handleSubstitutionQuery(schoolData);
  }

  // ----------------------------------------------------------------------------
  // 6. TÌM GIÁO VIÊN ĐANG TRỐNG TIẾT (SMART FREE TEACHER FINDER)
  // ----------------------------------------------------------------------------
  if (clean.startsWith("tim gv") || clean.startsWith("gv trong") || clean.startsWith("ai ranh") || clean.includes("trong tiet") || clean.includes("ranh tiet")) {
    var schoolData = fetchSchoolTimetableData();
    return handleFindFreeTeacherQuery(text, clean, schoolData);
  }

  // ----------------------------------------------------------------------------
  // 7. THÔNG BÁO ĐỢT TKB MỚI / TẢI IN TKB
  // ----------------------------------------------------------------------------
  if (clean === "tkb moi" || clean === "dot tkb" || clean === "thong bao" || clean === "thong bao tkb") {
    var schoolData = fetchSchoolTimetableData();
    return handleNewTimetableAnnouncement(schoolData);
  }

  // ----------------------------------------------------------------------------
  // 8. TRA CỨU THỜI KHÓA BIỂU THEO LỚP HOẶC GIÁO VIÊN
  // ----------------------------------------------------------------------------
  var schoolData = fetchSchoolTimetableData();
  if (schoolData) {
    var tkbResponse = handleNaturalTimetableQuery(text, clean, schoolData);
    if (tkbResponse) {
      return tkbResponse;
    }
  }

  // Nếu không khớp cú pháp nào
  return "🤖 Trợ lý Trường học THCS Chu Văn An chưa nhận diện được yêu cầu: \"" + text + "\"\n\n" +
         "💡 Gợi ý cú pháp tra cứu nhanh:\n" +
         "👉 Gửi [Số điện thoại]: Kích hoạt nhận tin Ký số & Lịch dạy 6h00 sáng.\n" +
         "👉 Gõ: tkb 6a1 (hoặc tkb [Tên GV]): Xem TKB kèm khung giờ ra vào lớp.\n" +
         "👉 Gõ: hoso: Kiểm tra trạng thái giáo án đã nộp.\n" +
         "👉 Gõ: menu (hoặc help): Xem đầy đủ hướng dẫn.";
}

function formatDateSafe(date, fmt) {
  var d = date;
  if (!d || !(d instanceof Date) || isNaN(d.getTime())) {
    d = new Date();
  }

  if (typeof Utilities !== "undefined" && Utilities.formatDate) {
    try {
      return Utilities.formatDate(d, "Asia/Ho_Chi_Minh", fmt || "dd/MM/yyyy");
    } catch (e) {
      if (typeof Logger !== "undefined") {
        Logger.log("⚠️ Lỗi Utilities.formatDate: " + (e && e.message ? e.message : e));
      }
    }
  }

  var day = String(d.getDate()).padStart(2, "0");
  var month = String(d.getMonth() + 1).padStart(2, "0");
  var year = d.getFullYear();
  if (fmt === "yyyy/MM") return year + "/" + month;
  return day + "/" + month + "/" + year;
}

// ====================================================================================================
// 🌅 8. ENGINE TỰ ĐỘNG GỬI LỊCH DẠY 6H00 SÁNG CHO TỪNG GIÁO VIÊN THEO SĐT & BẢN TIN NHÓM
// ====================================================================================================
function sendDailyMorningPersonalSchedule() {
  try {
    if (typeof Logger !== "undefined") Logger.log("⏰ [MorningEngine] Bắt đầu quét lịch giảng dạy buổi sáng...");

    var todayDate = new Date();
    var dayOfWeek = todayDate.getDay(); // 0: Chủ Nhật, 1: Thứ Hai, ..., 6: Thứ Bảy

    // Chủ Nhật: Không gửi lịch học chính khóa, xử lý an toàn
    if (dayOfWeek === 0) {
      if (typeof Logger !== "undefined") Logger.log("🌴 Hôm nay là Chủ Nhật. Bỏ qua gửi tin nhắn giảng dạy.");
      return { status: "sunday_skip", message: "Sunday excluded gracefully" };
    }

    var dayMap = { 1: "T2", 2: "T3", 3: "T4", 4: "T5", 5: "T6", 6: "T7" };
    var dayKey = dayMap[dayOfWeek] || "T2";
    var dayNames = { "T2": "Thứ Hai", "T3": "Thứ Ba", "T4": "Thứ Tư", "T5": "Thứ Năm", "T6": "Thứ Sáu", "T7": "Thứ Bảy" };

    var schoolData = fetchSchoolTimetableData();
    if (!schoolData) {
      if (typeof Logger !== "undefined") Logger.log("⚠️ [MorningEngine] Không thể kết nối dữ liệu Firebase TKB (Firebase offline/unreachable). Tạm dừng gửi lịch an toàn.");
      return { status: "error", error: "NO_TKB_DATA", message: "Firebase is unreachable or returned null" };
    }

    var ss = getDatabaseSpreadsheet();
    if (!ss) {
      if (typeof Logger !== "undefined") Logger.log("⚠️ Không thể kết nối cơ sở dữ liệu Google Spreadsheet.");
      return { status: "error", error: "NO_SPREADSHEET" };
    }

    var sheetUsers = ss.getSheetByName(CONFIG.SHEET_USERS);
    if (!sheetUsers) {
      if (typeof Logger !== "undefined") Logger.log("❌ Không tìm thấy bảng Danh bạ GV: " + CONFIG.SHEET_USERS);
      return { status: "error", error: "NO_SHEET_USERS" };
    }

    var usersData = sheetUsers.getDataRange().getValues();
    if (!usersData || usersData.length <= 1) {
      if (typeof Logger !== "undefined") Logger.log("ℹ️ Danh bạ giáo viên chưa có dữ liệu.");
      return { status: "empty_users", sentCount: 0, skipCount: 0 };
    }

    var sentCount = 0;
    var skipCount = 0;
    var dateStr = formatDateSafe(todayDate, "dd/MM/yyyy");

    for (var i = 1; i < usersData.length; i++) {
      try {
        var teacherName = String(usersData[i][1] || "").trim();
        var phone = String(usersData[i][2] || "").trim();
        var chatId = String(usersData[i][5] || "").trim();
        var shortName = String(usersData[i][7] || "").trim();

        // Bỏ qua nếu giáo viên chưa liên kết Zalo
        if (!chatId) {
          skipCount++;
          continue;
        }

        // Tìm đối tượng giáo viên trong TKB
        var searchKey = shortName || teacherName;
        var matchedTeacher = findMatchingTeacher(searchKey, schoolData.teachers || []);

        if (!matchedTeacher) {
          continue;
        }

        // Soạn tin nhắn lịch dạy cá nhân hôm nay
        var morningMsg = generateMorningTeacherMessage(matchedTeacher, schoolData, dayKey, dayNames[dayKey], dateStr);

        if (morningMsg) {
          sendZaloBotReply(chatId, morningMsg);
          sentCount++;
          // Nghỉ 150ms để chống nghẽn rate limit Zalo Bot API
          if (typeof Utilities !== "undefined" && Utilities.sleep) {
            Utilities.sleep(150);
          }
        }
      } catch (teacherErr) {
        if (typeof Logger !== "undefined") {
          Logger.log("⚠️ Lỗi khi gửi lịch cho GV dòng " + (i + 1) + ": " + teacherErr.toString());
        }
      }
    }

    if (typeof Logger !== "undefined") {
      Logger.log("🎉 [MorningEngine] Hoàn tất gửi lịch sáng: Đã gửi cho " + sentCount + " giáo viên. Bỏ qua " + skipCount + " chưa liên kết Zalo.");
    }
    return { status: "success", sentCount: sentCount, skipCount: skipCount };
  } catch (err) {
    if (typeof Logger !== "undefined") Logger.log("❌ Lỗi nghiêm trọng trong sendDailyMorningPersonalSchedule: " + err.toString());
    return { status: "error", error: err.toString() };
  }
}

/**
 * Gửi bản tin Thời khóa biểu tổng hợp buổi sáng vào nhóm Zalo chung của nhà trường
 * Thời gian gửi: ~06:30 sáng hàng ngày (tự động loại trừ Chủ Nhật)
 * @return {object} - Kết quả gửi bản tin
 */
function sendMorningBriefGroup() {
  try {
    if (typeof Logger !== "undefined") Logger.log("⏰ [MorningBriefGroup] Bắt đầu tổng hợp bản tin TKB toàn trường...");

    var todayDate = new Date();
    var dayOfWeek = todayDate.getDay(); // 0: Chủ Nhật, 1: Thứ Hai, ..., 6: Thứ Bảy

    // Chủ Nhật: Không gửi bản tin nhóm
    if (dayOfWeek === 0) {
      if (typeof Logger !== "undefined") Logger.log("🌴 Hôm nay là Chủ Nhật. Bỏ qua gửi bản tin TKB nhóm.");
      return { status: "sunday_skip", message: "Sunday excluded gracefully" };
    }

    var groupId = getMorningBriefChatId();
    if (!groupId) {
      if (typeof Logger !== "undefined") Logger.log("⚠️ MORNING_BRIEF_CHAT_ID để trống. Bỏ qua gửi bản tin nhóm.");
      return { status: "skipped", message: "NO_GROUP_CHAT_ID" };
    }

    var schoolData = fetchSchoolTimetableData();
    if (!schoolData) {
      if (typeof Logger !== "undefined") Logger.log("⚠️ [MorningBriefGroup] Không thể kết nối dữ liệu Firebase TKB (Firebase offline/unreachable). Tạm dừng gửi an toàn.");
      return { status: "error", error: "NO_TKB_DATA", message: "Firebase is unreachable or returned null" };
    }

    var dayMap = { 1: "T2", 2: "T3", 3: "T4", 4: "T5", 5: "T6", 6: "T7" };
    var dayKey = dayMap[dayOfWeek] || "T2";
    var dayNames = { "T2": "Thứ Hai", "T3": "Thứ Ba", "T4": "Thứ Tư", "T5": "Thứ Năm", "T6": "Thứ Sáu", "T7": "Thứ Bảy" };
    var dateStr = formatDateSafe(todayDate, "dd/MM/yyyy");

    var briefMsg = generateMorningSchoolBriefMessage(schoolData, dayKey, dayNames[dayKey], dateStr);
    if (!briefMsg) {
      if (typeof Logger !== "undefined") Logger.log("ℹ️ Không có nội dung bản tin cho ngày hôm nay.");
      return { status: "empty" };
    }

    var sendRes = sendZaloBotReply(groupId, briefMsg);
    if (typeof Logger !== "undefined") {
      Logger.log("🎉 [MorningBriefGroup] Đã gửi bản tin TKB tổng hợp tới nhóm Zalo (" + groupId + ").");
    }
    return { status: "success", delivered: true, groupId: groupId, result: sendRes };
  } catch (err) {
    if (typeof Logger !== "undefined") Logger.log("❌ Lỗi trong sendMorningBriefGroup: " + err.toString());
    return { status: "error", error: err.toString() };
  }
}

/**
 * Soạn bản tin Thời khóa biểu tổng hợp buổi sáng cho toàn trường (đăng nhóm Zalo)
 * Hiển thị tổng quan các ca học sáng/chiều và danh sách phân công dạy thay trong ngày
 * @param {object} schoolData - Dữ liệu thời khóa biểu trường
 * @param {string} dayKey - Mã ngày (T2, T3, ..., T7)
 * @param {string} dayName - Tên ngày (Thứ Hai, Thứ Ba, ...)
 * @param {string} dateStr - Chuỗi ngày định dạng dd/MM/yyyy
 * @return {string|null} - Nội dung tin nhắn bản tin
 */
function generateMorningSchoolBriefMessage(schoolData, dayKey, dayName, dateStr) {
  if (!schoolData || typeof schoolData !== "object") return null;

  var active = getActiveTimetable(schoolData) || {};
  var timetable = (active && active.timetable && typeof active.timetable === "object") ? active.timetable : {};
  var classes = Array.isArray(schoolData.classes) ? schoolData.classes : [];
  var substitutions = Array.isArray(schoolData.substitutions) ? schoolData.substitutions : [];

  var morningClasses = [];
  var afternoonClasses = [];

  classes.forEach(function(c) {
    if (!c || typeof c !== "object") return;
    var sess = String(c.session || "sáng").toLowerCase();
    var className = String(c.name || "").trim();
    if (!className) return;

    var clsTkb = timetable[className];
    var daySchedule = (clsTkb && clsTkb[dayKey]) ? clsTkb[dayKey] : null;
    var hasTeaching = false;
    if (daySchedule) {
      for (var p = 1; p <= 5; p++) {
        if (daySchedule[p] && daySchedule[p].subject) {
          hasTeaching = true;
          break;
        }
      }
    }
    if (hasTeaching) {
      if (sess === "sáng") morningClasses.push(className);
      else afternoonClasses.push(className);
    }
  });

  // Bóc tách ca dạy thay hôm nay
  var todaySubs = [];
  substitutions.forEach(function(s) {
    if (!s || typeof s !== "object") return;
    var matches = true;
    var sDay = s.day != null ? String(s.day).trim() : "";
    if (sDay && sDay !== dayKey) matches = false;

    var sDate = typeof s.date === "string" ? s.date.trim() : (s.date != null ? String(s.date).trim() : "");
    if (sDate && sDate !== "Hôm nay" && sDate !== dateStr) {
      if (sDate.indexOf("/") !== -1 && sDate !== dateStr) matches = false;
    }
    if (matches) todaySubs.push(s);
  });

  var schoolTitle = (typeof CONFIG !== "undefined" && CONFIG && typeof CONFIG.SCHOOL_NAME === "string" && CONFIG.SCHOOL_NAME.trim())
    ? CONFIG.SCHOOL_NAME.trim()
    : "TRƯỜNG THCS CHU VĂN AN";
  var msg = "🌅 BẢN TIN THỜI KHÓA BIỂU TOÀN TRƯỜNG (*" + dayName + "* - " + dateStr + ")\n" +
            "🏫 *" + schoolTitle.toUpperCase() + "*\n" +
            "Chúc quý Thầy/Cô một ngày giảng dạy thành công và hiệu quả! ✨\n\n" +
            "📊 TỔNG QUAN CÁC CA HỌC HÔM NAY:\n" +
            "• 🌅 Buổi Sáng (07:00 - 11:15): " + morningClasses.length + " lớp học (" + (morningClasses.join(", ") || "Không có") + ")\n" +
            "• 🌇 Buổi Chiều (12:45 - 17:00): " + afternoonClasses.length + " lớp học (" + (afternoonClasses.join(", ") || "Không có") + ")\n";

  if (todaySubs.length > 0) {
    msg += "\n🔄 PHÂN CÔNG DẠY THAY HÔM NAY (" + todaySubs.length + " ca):\n";
    todaySubs.forEach(function(s, idx) {
      msg += (idx + 1) + ". Tiết " + (s.period || "") + " | Lớp " + (s.className || "") + " (" + (s.subject || "") + ")\n" +
             "   • GV vắng: " + (s.originalTeacher || "N/A") + "\n" +
             "   • 👉 GV DẠY THAY: *" + (s.substituteTeacher || "Chưa phân công") + "*\n" +
             (s.note ? ("   • Ghi chú: " + s.note + "\n") : "");
    });
  } else {
    msg += "\n🔄 DẠY THAY: ✨ Toàn trường thực hiện đúng TKB chính khóa, không có ca dạy thay.\n";
  }

  var portalUrl = (typeof CONFIG !== "undefined" && CONFIG && typeof CONFIG.PUBLIC_TKB_PORTAL === "string" && CONFIG.PUBLIC_TKB_PORTAL.trim())
    ? CONFIG.PUBLIC_TKB_PORTAL.trim()
    : "https://edusign.cva.edu.vn";
  msg += "\n🌐 Cổng TKB Online: " + portalUrl + "\n" +
         "💡 Quý Thầy/Cô có thể gửi [Số Điện Thoại] hoặc gõ \"tkb [Tên GV]\" để tra cứu lịch riêng.";

  return msg;
}

/**
 * Trình tạo nội dung tin nhắn chào buổi sáng tinh gọn kèm khung giờ chuẩn
 */
function generateMorningTeacherMessage(teacher, schoolData, dayKey, dayName, dateStr) {
  if (!teacher || typeof teacher !== "object" || !schoolData || typeof schoolData !== "object") return "";

  var teacherShortName = String(teacher.shortName || "").trim();
  var fullName = typeof teacher.fullName === "string" ? teacher.fullName.trim() : (teacher.fullName != null ? String(teacher.fullName).trim() : "");
  if (!teacherShortName && !fullName) return "";

  var active = getActiveTimetable(schoolData) || {};
  var timetable = (active && active.timetable && typeof active.timetable === "object") ? active.timetable : {};
  var classes = Array.isArray(schoolData.classes) ? schoolData.classes : [];
  var substitutions = Array.isArray(schoolData.substitutions) ? schoolData.substitutions : [];

  var morningSlots = [];
  var afternoonSlots = [];

  // 1. Quét các tiết dạy chính khóa của giáo viên
  classes.forEach(function(c) {
    if (!c || typeof c !== "object") return;
    var session = typeof c.session === "string" ? c.session.toLowerCase() : "sáng";
    var className = String(c.name || "").trim();
    if (!className) return;

    var clsTkb = timetable[className];
    var daySchedule = (clsTkb && clsTkb[dayKey]) ? clsTkb[dayKey] : null;
    if (daySchedule) {
      for (var p = 1; p <= 5; p++) {
        if (daySchedule[p] && daySchedule[p].teacher === teacherShortName) {
          var timeStr = (formatPeriodTime(session, p) || "").replace(/\s+/g, "");
          var item = {
            period: p,
            subject: daySchedule[p].subject,
            className: className,
            session: session,
            time: timeStr
          };
          if (session === "sáng") morningSlots.push(item);
          else afternoonSlots.push(item);
        }
      }
    }
  });

  morningSlots.sort(function(a, b) { return a.period - b.period; });
  afternoonSlots.sort(function(a, b) { return a.period - b.period; });

  // 2. Quét các ca dạy thay hôm nay (nếu có)
  var mySubs = [];
  substitutions.forEach(function(sub) {
    if (!sub || typeof sub !== "object") return;
    if (sub.substituteTeacher === teacherShortName) {
      mySubs.push(sub);
    }
  });

  var totalPeriods = morningSlots.length + afternoonSlots.length + mySubs.length;

  // Nếu hôm nay giáo viên không có tiết dạy nào
  if (totalPeriods === 0) {
    return null; // Không gửi để tránh làm phiền giáo viên trong ngày nghỉ
  }

  var displayName = fullName ? fullName : teacherShortName;
  var msg = "🌅 LỊCH GIẢNG DẠY HÔM NAY (*" + dayName + "* - " + dateStr + ")\n" +
            "Kính chào Thầy/Cô *" + displayName.toUpperCase() + "*! ✨\n" +
            "Chúc Thầy/Cô một ngày làm việc hiệu quả.\n\n" +
            "📋 Hôm nay Thầy/Cô có " + totalPeriods + " tiết dạy:\n";

  if (morningSlots.length > 0) {
    msg += "\n🌅 Sáng (" + morningSlots.length + " tiết):\n";
    morningSlots.forEach(function(s) {
      msg += "• Tiết " + s.period + " (" + s.time + "): " + s.subject + " - " + s.className + "\n";
    });
  }

  if (afternoonSlots.length > 0) {
    msg += "\n🌇 Chiều (" + afternoonSlots.length + " tiết):\n";
    afternoonSlots.forEach(function(s) {
      msg += "• Tiết " + s.period + " (" + s.time + "): " + s.subject + " - " + s.className + "\n";
    });
  }

  if (mySubs.length > 0) {
    msg += "\n🔄 CA DẠY THAY TRONG NGÀY:\n";
    mySubs.forEach(function(sub) {
      msg += "• Tiết " + (sub.period || "N/A") + " (" + (sub.className || "") + "): Dạy thay cho GV " + (sub.originalTeacher || "") + "\n";
    });
  }

  msg += "\n🌐 In TKB: " + CONFIG.PUBLIC_TKB_PORTAL + "?gv=" + encodeURIComponent(teacher.shortName) + "\n" +
         "💡 Để xem hồ sơ giáo án: gõ \"hoso\"";

  return msg;
}

// ====================================================================================================
// ⏰ 9. ĐỊNH DẠNG KHUNG GIỜ VÀO/RA LỚP (TIME SLOTS FORMATTER)
// ====================================================================================================
function formatPeriodTime(session, period) {
  var sess = (session || "sáng").toLowerCase();
  var times = CONFIG.PERIOD_TIMES[sess];
  if (times && times[period]) {
    return times[period];
  }
  return (sess === "chiều" ? "13h00 - 17h05" : "07h00 - 11h05");
}

/**
 * Lấy khung giờ tổng quan toàn bộ ca học (sáng: 07:00 - 11:15, chiều: 12:45 - 17:00)
 * @param {string} session - Buổi học ("sáng" hoặc "chiều")
 * @return {string} - Chuỗi khung giờ ca học
 */
function getSessionSpan(session) {
  var sess = (session || "sáng").toLowerCase();
  if (CONFIG.SESSION_HOURS && CONFIG.SESSION_HOURS[sess]) {
    return CONFIG.SESSION_HOURS[sess];
  }
  return (sess === "chiều" ? "12:45 - 17:00" : "07:00 - 11:15");
}

function formatDepartmentName(raw) {
  if (!raw) return "";
  var map = {
    "g_toan_tin": "Tổ Toán - Tin",
    "g_khtn": "Tổ Khoa học Tự nhiên",
    "g_khxh": "Tổ Khoa học Xã hội",
    "g_su_dia": "Tổ Lịch sử - Địa lý",
    "g_van": "Tổ Ngữ văn",
    "g_anh": "Tổ Ngoại ngữ",
    "g_gdcd": "Tổ Giáo dục Công dân",
    "g_nghe_thuat": "Tổ Âm nhạc - Mỹ thuật",
    "g_the_chat": "Tổ Giáo dục Thể chất"
  };
  var str = typeof raw === "string" ? raw.trim() : String(raw).trim();
  var lower = str.toLowerCase();
  if (Object.prototype.hasOwnProperty.call(map, lower)) return map[lower];
  return str.replace(/^g_/, "Tổ ").replace(/_/g, " ");
}

/**
 * Thoát các ký tự định dạng Markdown đặc biệt cho Zalo (*, _, `, ~, [, ])
 * @param {string} text
 * @return {string}
 */
function escapeZaloMarkdown(text) {
  if (!text) return "";
  var str = typeof text === "string" ? text : String(text);
  return str.replace(/([*_`~\[\]\\])/g, "\\$1");
}

// ====================================================================================================
// 📊 10. TRÌNH ĐỊNH DẠNG THỜI KHÓA BIỂU KÈM KHUNG GIỜ (TỐI ƯU MÀN HÌNH ĐIỆN THOẠI)
// ====================================================================================================
function formatTeacherTimetableResponse(teacher, schoolData, dayFilter) {
  if (!teacher || typeof teacher !== "object") return "⚠️ Không tìm thấy thông tin giáo viên.";
  if (!schoolData || typeof schoolData !== "object") return "⚠️ Dữ liệu thời khóa biểu hiện chưa khả dụng.";

  var teacherShortName = String(teacher.shortName || "").trim();
  var fullName = typeof teacher.fullName === "string" ? teacher.fullName.trim() : (teacher.fullName != null ? String(teacher.fullName).trim() : "");
  var displayName = fullName ? fullName : teacherShortName;

  var active = getActiveTimetable(schoolData) || {};
  var timetable = (active && active.timetable && typeof active.timetable === "object") ? active.timetable : {};
  var classes = Array.isArray(schoolData.classes) ? schoolData.classes : [];
  var weekdays = dayFilter ? [dayFilter] : ["T2", "T3", "T4", "T5", "T6", "T7"];
  var dayNames = { "T2": "Thứ Hai", "T3": "Thứ Ba", "T4": "Thứ Tư", "T5": "Thứ Năm", "T6": "Thứ Sáu", "T7": "Thứ Bảy" };

  var safeDisplayName = escapeZaloMarkdown(displayName.toUpperCase());
  var safeShortName = escapeZaloMarkdown(teacherShortName);
  var out = "📅 LỊCH DẠY: *" + safeDisplayName + "* (" + safeShortName + ")\n";
  if (teacher.group) {
    out += "🏢 *" + escapeZaloMarkdown(formatDepartmentName(teacher.group)) + "*\n";
  }
  if (active.weekName) {
    var safeWeekName = escapeZaloMarkdown(String(active.weekName));
    var safeApplyDate = active.applyDate ? escapeZaloMarkdown(String(active.applyDate)) : "";
    out += "📌 " + safeWeekName + (safeApplyDate ? " (từ " + safeApplyDate + ")" : "") + "\n";
  }

  var hasAnyPeriod = false;

  weekdays.forEach(function(day) {
    var daySlots = {};

    classes.forEach(function(c) {
      if (!c || typeof c !== "object") return;
      var session = typeof c.session === "string" ? c.session.toLowerCase() : "sáng";
      var className = String(c.name || "").trim();
      if (!className) return;

      var clsTkb = (Object.prototype.hasOwnProperty.call(timetable, className) && timetable[className]) ? timetable[className] : null;
      var daySchedule = (clsTkb && clsTkb[day]) ? clsTkb[day] : null;
      if (daySchedule) {
        for (var p = 1; p <= 5; p++) {
          if (daySchedule[p] && daySchedule[p].teacher === teacherShortName) {
            var key = session + "_" + p;
            if (!daySlots[key]) {
              var timeStr = (formatPeriodTime(session, p) || "").replace(/\s+/g, "");
              daySlots[key] = {
                p: p,
                sub: daySchedule[p].subject,
                classes: [className],
                session: session,
                time: timeStr
              };
            } else {
              if (daySlots[key].classes.indexOf(className) === -1) {
                daySlots[key].classes.push(className);
              }
            }
          }
        }
      }
    });

    var morning = [];
    var afternoon = [];
    Object.keys(daySlots).forEach(function(k) {
      var s = daySlots[k];
      if (s.session === "sáng") morning.push(s);
      else afternoon.push(s);
    });

    morning.sort(function(a, b) { return a.p - b.p; });
    afternoon.sort(function(a, b) { return a.p - b.p; });

    if (morning.length > 0 || afternoon.length > 0) {
      hasAnyPeriod = true;
      var dayTitle = (dayNames[day] || day).toUpperCase();
      out += "\n🗓️ *" + dayTitle + "*:\n";

      if (morning.length > 0) {
        out += "🌅 Sáng:\n";
        morning.forEach(function(s) {
          out += "• Tiết " + s.p + " (" + s.time + "): " + s.sub + " - " + s.classes.join(", ") + "\n";
        });
      }

      if (afternoon.length > 0) {
        out += "🌇 Chiều:\n";
        afternoon.forEach(function(s) {
          out += "• Tiết " + s.p + " (" + s.time + "): " + s.sub + " - " + s.classes.join(", ") + "\n";
        });
      }
    }
  });

  if (!hasAnyPeriod) {
    if (dayFilter) {
      var dName = dayNames[dayFilter] || dayFilter;
      out += "\n🌴 *" + dName + "*: Thầy/Cô không có tiết dạy.\n";
      var nextSchedule = findNextTeachingSession(teacher, schoolData, dayFilter);
      if (nextSchedule) {
        out += "\n🗓️ *LỊCH DẠY BUỔI TIẾP THEO* (*" + nextSchedule.dayName + "*):\n" + nextSchedule.content + "\n";
      }
    } else {
      out += "\n🌴 Thầy/Cô không có tiết dạy trong thời khóa biểu tuần này.\n";
    }
  }

  var portalUrl = (CONFIG && CONFIG.PUBLIC_TKB_PORTAL) ? CONFIG.PUBLIC_TKB_PORTAL : "";
  out += "\n🌐 In TKB: " + portalUrl + "?gv=" + encodeURIComponent((teacher && teacher.shortName) ? teacher.shortName : "");
  return out;
}

function formatClassTimetableResponse(cls, schoolData, dayFilter) {
  if (!cls || typeof cls !== "object" || !schoolData || typeof schoolData !== "object") {
    return "⚠️ Không tìm thấy dữ liệu lớp hoặc dữ liệu trường.";
  }
  var active = getActiveTimetable(schoolData) || {};
  var timetable = (active && active.timetable && typeof active.timetable === "object") ? active.timetable : {};
  var session = String(cls.session || "sáng").toLowerCase();
  var weekdays = dayFilter ? [dayFilter] : ["T2", "T3", "T4", "T5", "T6", "T7"];
  var dayNames = { "T2": "Thứ Hai", "T3": "Thứ Ba", "T4": "Thứ Tư", "T5": "Thứ Năm", "T6": "Thứ Sáu", "T7": "Thứ Bảy" };

  var gvcnInfo = getHomeroomTeacher(cls, timetable, schoolData.assignments, schoolData.teachers);

  var clsDisplayName = escapeZaloMarkdown(String(cls.name || "").trim());
  var out = "🏫 TKB LỚP *" + clsDisplayName + "* (*" + (session === "chiều" ? "Buổi Chiều" : "Buổi Sáng") + "*)\n";
  if (gvcnInfo) {
    out += "👨‍🏫 GVCN: *" + escapeZaloMarkdown(String(gvcnInfo)) + "*\n";
  }
  if (active.weekName) {
    out += "📌 " + escapeZaloMarkdown(String(active.weekName)) + (active.applyDate ? " (từ " + escapeZaloMarkdown(String(active.applyDate)) + ")" : "") + "\n";
  }

  var hasSlots = false;
  var clsName = String(cls.name || "").trim();
  var clsSchedule = (Object.prototype.hasOwnProperty.call(timetable, clsName) && timetable[clsName] && typeof timetable[clsName] === "object") ? timetable[clsName] : {};

  weekdays.forEach(function(day) {
    var slots = [];
    var daySchedule = (clsSchedule && Object.prototype.hasOwnProperty.call(clsSchedule, day) && clsSchedule[day] && typeof clsSchedule[day] === "object") ? clsSchedule[day] : null;
    for (var p = 1; p <= 5; p++) {
      if (daySchedule && Object.prototype.hasOwnProperty.call(daySchedule, p) && daySchedule[p]) {
        var item = daySchedule[p];
        var timeStr = (formatPeriodTime(session, p) || "").replace(/\s+/g, "");
        slots.push({
          p: p,
          sub: item.subject ? String(item.subject).trim() : "(Chưa có môn)",
          tea: item.teacher ? String(item.teacher).trim() : "",
          time: timeStr
        });
      }
    }

    if (slots.length > 0) {
      hasSlots = true;
      var dayTitle = (dayNames[day] || day).toUpperCase();
      out += "\n🗓️ *" + escapeZaloMarkdown(dayTitle) + "*:\n";
      out += (session === "chiều" ? "🌇 Chiều:\n" : "🌅 Sáng:\n");
      slots.forEach(function(s) {
        var teacherStr = s.tea ? " (" + escapeZaloMarkdown(s.tea) + ")" : "";
        out += "• Tiết " + s.p + " (" + s.time + "): " + escapeZaloMarkdown(s.sub) + teacherStr + "\n";
      });
    }
  });

  if (!hasSlots) {
    out += "\n🌴 Lớp không có tiết học trong thời gian này.\n";
  }

  var portalUrl = (CONFIG && CONFIG.PUBLIC_TKB_PORTAL) ? CONFIG.PUBLIC_TKB_PORTAL : "";
  out += "\n🌐 Xem TKB: " + portalUrl + "?lop=" + encodeURIComponent(clsName);
  return out;
}

/**
 * Tạo tin nhắn TKB ngày mai thông minh cho Giáo viên
 */
function generateTomorrowTeacherMessage(teacher, schoolData, targetDate) {
  if (!teacher || typeof teacher !== "object") {
    return "⚠️ Không tìm thấy thông tin giáo viên.";
  }
  if (!schoolData || typeof schoolData !== "object") {
    return "⚠️ Không tìm thấy dữ liệu trường học.";
  }
  var teacherShortName = String(teacher.shortName || "").trim();
  if (!teacherShortName) {
    return "⚠️ Thiếu tên viết tắt của giáo viên.";
  }
  var tomorrow = (targetDate instanceof Date && !isNaN(targetDate.getTime())) ? targetDate : new Date(new Date().getTime() + 24 * 60 * 60 * 1000);
  var dayOfWeek = tomorrow.getDay(); // 0: Chủ Nhật, 1: T2, ..., 6: T7
  var dayMap = { 0: "CN", 1: "T2", 2: "T3", 3: "T4", 4: "T5", 5: "T6", 6: "T7" };
  var dayKey = dayMap[dayOfWeek] || "T2";
  var dayNames = { "T2": "Thứ Hai", "T3": "Thứ Ba", "T4": "Thứ Tư", "T5": "Thứ Năm", "T6": "Thứ Sáu", "T7": "Thứ Bảy", "CN": "Chủ Nhật" };
  var dayName = dayNames[dayKey] || dayKey;
  var dateStr = formatDateSafe(tomorrow, "dd/MM/yyyy");

  var active = getActiveTimetable(schoolData) || {};
  var timetable = (active && active.timetable && typeof active.timetable === "object") ? active.timetable : {};
  var classes = Array.isArray(schoolData.classes) ? schoolData.classes : [];

  var morningSlots = [];
  var afternoonSlots = [];

  if (dayKey !== "CN") {
    classes.forEach(function(c) {
      if (!c || typeof c !== "object") return;
      var session = String(c.session || "sáng").toLowerCase();
      var cName = String(c.name || "").trim();
      var clsTkb = (Object.prototype.hasOwnProperty.call(timetable, cName) && timetable[cName] && typeof timetable[cName] === "object") ? timetable[cName] : null;
      if (clsTkb && Object.prototype.hasOwnProperty.call(clsTkb, dayKey) && clsTkb[dayKey] && typeof clsTkb[dayKey] === "object") {
        var dayPeriods = clsTkb[dayKey];
        for (var p = 1; p <= 5; p++) {
          if (Object.prototype.hasOwnProperty.call(dayPeriods, p) && dayPeriods[p] && typeof dayPeriods[p] === "object") {
            var periodObj = dayPeriods[p];
            if (String(periodObj.teacher || "").trim() === teacherShortName) {
              var timeStr = (formatPeriodTime(session, p) || "").replace(/\s+/g, "");
              var item = {
                period: p,
                subject: periodObj.subject ? String(periodObj.subject).trim() : "(Chưa có môn)",
                className: cName,
                session: session,
                time: timeStr
              };
              if (session === "sáng") morningSlots.push(item);
              else afternoonSlots.push(item);
            }
          }
        }
      }
    });
  }

  morningSlots.sort(function(a, b) { return a.period - b.period; });
  afternoonSlots.sort(function(a, b) { return a.period - b.period; });
  var totalPeriods = morningSlots.length + afternoonSlots.length;

  var teacherFullName = escapeZaloMarkdown(String(teacher.fullName || teacher.shortName || "").toUpperCase());
  var teacherShort = escapeZaloMarkdown(teacherShortName);
  var msg = "📅 LỊCH GIẢNG DẠY NGÀY MAI (*" + escapeZaloMarkdown(dayName) + "* - " + escapeZaloMarkdown(dateStr) + ")\n" +
            "👤 Thầy/Cô: *" + teacherFullName + "* (" + teacherShort + ")\n";

  if (totalPeriods === 0) {
    msg += "\n🌴 Ngày mai Thầy/Cô *KHÔNG CÓ TIẾT DẠY*. Chúc Thầy/Cô có thời gian nghỉ ngơi vui vẻ!\n";
    var nextSchedule = findNextTeachingSession(teacher, schoolData, dayKey);
    if (nextSchedule) {
      msg += "\n🗓️ *LỊCH DẠY BUỔI TIẾP THEO* (*" + escapeZaloMarkdown(nextSchedule.dayName) + "*):\n" + nextSchedule.content + "\n";
    }
  } else {
    msg += "📋 Ngày mai Thầy/Cô có " + totalPeriods + " tiết dạy:\n";
    if (morningSlots.length > 0) {
      msg += "\n🌅 Sáng (" + morningSlots.length + " tiết):\n";
      morningSlots.forEach(function(s) {
        msg += "• Tiết " + s.period + " (" + s.time + "): " + escapeZaloMarkdown(s.subject) + " - " + escapeZaloMarkdown(s.className) + "\n";
      });
    }
    if (afternoonSlots.length > 0) {
      msg += "\n🌇 Chiều (" + afternoonSlots.length + " tiết):\n";
      afternoonSlots.forEach(function(s) {
        msg += "• Tiết " + s.period + " (" + s.time + "): " + escapeZaloMarkdown(s.subject) + " - " + escapeZaloMarkdown(s.className) + "\n";
      });
    }
  }

  var portalUrl = (CONFIG && CONFIG.PUBLIC_TKB_PORTAL) ? CONFIG.PUBLIC_TKB_PORTAL : "";
  msg += "\n🌐 Tra cứu chi tiết: " + portalUrl + "?gv=" + encodeURIComponent(teacherShortName);
  return msg;
}

/**
 * Tự động tìm buổi dạy gần nhất tiếp theo trong tuần
 */
function findNextTeachingSession(teacher, schoolData, afterDayKey) {
  if (!teacher || typeof teacher !== "object" || !schoolData || typeof schoolData !== "object") {
    return null;
  }
  var teacherShortName = String(teacher.shortName || "").trim();
  if (!teacherShortName) return null;
  var active = getActiveTimetable(schoolData) || {};
  var timetable = (active && active.timetable && typeof active.timetable === "object") ? active.timetable : {};
  var classes = Array.isArray(schoolData.classes) ? schoolData.classes : [];
  var order = ["T2", "T3", "T4", "T5", "T6", "T7"];
  var dayNames = { "T2": "Thứ Hai", "T3": "Thứ Ba", "T4": "Thứ Tư", "T5": "Thứ Năm", "T6": "Thứ Sáu", "T7": "Thứ Bảy" };

  var startIdx = order.indexOf(afterDayKey);
  if (startIdx === -1) startIdx = 0;

  for (var step = 1; step <= 6; step++) {
    var d = order[(startIdx + step) % 6];
    var slots = [];
    classes.forEach(function(c) {
      if (!c || typeof c !== "object") return;
      var session = String(c.session || "sáng").toLowerCase();
      var cName = String(c.name || "").trim();
      var clsTkb = (Object.prototype.hasOwnProperty.call(timetable, cName) && timetable[cName] && typeof timetable[cName] === "object") ? timetable[cName] : null;
      if (clsTkb && Object.prototype.hasOwnProperty.call(clsTkb, d) && clsTkb[d] && typeof clsTkb[d] === "object") {
        var dayPeriods = clsTkb[d];
        for (var p = 1; p <= 5; p++) {
          if (Object.prototype.hasOwnProperty.call(dayPeriods, p) && dayPeriods[p] && typeof dayPeriods[p] === "object") {
            var periodObj = dayPeriods[p];
            if (String(periodObj.teacher || "").trim() === teacherShortName) {
              var timeStr = (formatPeriodTime(session, p) || "").replace(/\s+/g, "");
              slots.push({
                p: p,
                sub: periodObj.subject ? String(periodObj.subject).trim() : "(Chưa có môn)",
                cls: cName,
                session: session,
                time: timeStr
              });
            }
          }
        }
      }
    });

    if (slots.length > 0) {
      slots.sort(function(a, b) { return a.p - b.p; });
      var morning = slots.filter(function(s) { return s.session === "sáng"; });
      var afternoon = slots.filter(function(s) { return s.session !== "sáng"; });
      var lines = [];
      if (morning.length > 0) {
        lines.push("🌅 Sáng:");
        morning.forEach(function(s) {
          lines.push("• Tiết " + s.p + " (" + s.time + "): " + escapeZaloMarkdown(s.sub) + " - " + escapeZaloMarkdown(s.cls));
        });
      }
      if (afternoon.length > 0) {
        lines.push("🌇 Chiều:");
        afternoon.forEach(function(s) {
          lines.push("• Tiết " + s.p + " (" + s.time + "): " + escapeZaloMarkdown(s.sub) + " - " + escapeZaloMarkdown(s.cls));
        });
      }
      return {
        dayKey: d,
        dayName: dayNames[d] || d,
        content: lines.join("\n")
      };
    }
  }
  return null;
}

/**
 * HÀM TEST NHANH 1-CHẠM: Gửi thử lịch ngày mai cho giáo viên theo SĐT
 */
function testSendTomorrowSchedule(targetPhone) {
  try {
    var phone = targetPhone || "0818810007";
    var normPhone = normalizePhone(phone);
    Logger.log("🚀 [TestTomorrow] Bắt đầu kiểm tra gửi lịch ngày mai cho SĐT: " + phone);

    var schoolData;
    try {
      schoolData = fetchSchoolTimetableData();
    } catch (errSchool) {
      Logger.log("⚠️ [TestTomorrow] Lỗi kết nối fetchSchoolTimetableData: " + errSchool);
      return { success: false, error: "Không thể kết nối dữ liệu Firebase TKB: " + (errSchool && errSchool.message ? errSchool.message : String(errSchool)) };
    }
    if (!schoolData || typeof schoolData !== "object") {
      return { success: false, error: "Không thể kết nối dữ liệu Firebase TKB" };
    }

    var ss;
    try {
      ss = getDatabaseSpreadsheet();
    } catch (errSs) {
      Logger.log("⚠️ [TestTomorrow] Lỗi mở Database Spreadsheet: " + errSs);
      return { success: false, error: "Không mở được cơ sở dữ liệu Spreadsheet" };
    }
    if (!ss) {
      return { success: false, error: "Không mở được cơ sở dữ liệu Spreadsheet" };
    }
    var sheetUsers = ss.getSheetByName(CONFIG.SHEET_USERS);
    if (!sheetUsers) {
      return { success: false, error: "Không tìm thấy Sheet Danh bạ GV" };
    }

    var data;
    try {
      data = sheetUsers.getDataRange().getValues();
    } catch (errData) {
      Logger.log("⚠️ [TestTomorrow] Lỗi đọc dữ liệu sheetUsers: " + errData);
      return { success: false, error: "Lỗi truy xuất dữ liệu Danh bạ GV" };
    }
    if (!Array.isArray(data)) {
      return { success: false, error: "Dữ liệu Danh bạ GV không hợp lệ" };
    }
    var foundTeacher = null;
    var chatId = null;
    var shortName = null;

    for (var i = 1; i < data.length; i++) {
      if (!Array.isArray(data[i])) continue;
      var rowPhone = normalizePhone(String(data[i][2] || ""));
      if (rowPhone && rowPhone === normPhone) {
        foundTeacher = String(data[i][1] || "");
        chatId = String(data[i][5] || "").trim();
        shortName = String(data[i][7] || "").trim();
        break;
      }
    }

    if (!foundTeacher) {
      return { success: false, error: "Không tìm thấy giáo viên với SĐT " + phone + " trong Danh bạ GV" };
    }

    var teachersList = Array.isArray(schoolData.teachers) ? schoolData.teachers : [];
    var matchedTeacher = findMatchingTeacher(shortName || foundTeacher, teachersList);
    if (!matchedTeacher) {
      return { success: false, error: "Không khớp được giáo viên trong dữ liệu TKB với tên: " + (shortName || foundTeacher) };
    }

    var tomorrowMsg = generateTomorrowTeacherMessage(matchedTeacher, schoolData);
    Logger.log("📝 Nội dung tin nhắn chuẩn bị gửi:\n" + tomorrowMsg);

    var sentToZalo = false;
    if (chatId) {
      try {
        sendZaloBotReply(chatId, tomorrowMsg);
        sentToZalo = true;
        Logger.log("✅ Đã phát lệnh gửi Zalo Bot tới Chat ID: " + chatId);
      } catch (errSend) {
        Logger.log("⚠️ [TestTomorrow] Lỗi phát lệnh sendZaloBotReply: " + errSend);
        return {
          success: false,
          error: "Không thể gửi tin nhắn qua Zalo Bot: " + (errSend && errSend.message ? errSend.message : String(errSend)),
          teacher: matchedTeacher.fullName || "",
          shortName: matchedTeacher.shortName || "",
          chatId: chatId,
          message: tomorrowMsg
        };
      }
    } else {
      Logger.log("⚠️ Giáo viên chưa có Zalo_Chat_ID trong Sheet. Tin nhắn chưa thể chuyển trực tiếp qua Zalo.");
    }

    return {
      success: true,
      sentToZalo: sentToZalo,
      teacher: matchedTeacher.fullName || "",
      shortName: matchedTeacher.shortName || "",
      chatId: chatId,
      message: tomorrowMsg
    };
  } catch (err) {
    Logger.log("❌ [TestTomorrow] Lỗi không mong muốn trong testSendTomorrowSchedule: " + err);
    return {
      success: false,
      error: "Lỗi hệ thống khi kiểm tra gửi lịch: " + (err && err.message ? err.message : String(err))
    };
  }
}

// ====================================================================================================
// 🔍 11. XỬ LÝ TRA CỨU NGÔN NGỮ TỰ NHIÊN (NLP MATCHERS)
// ====================================================================================================
function handleNaturalTimetableQuery(text, clean, schoolData) {
  if (!schoolData || typeof schoolData !== "object") {
    return "⚠️ Không có dữ liệu thời khóa biểu trường.";
  }
  var safeText = String(text || "").trim();
  var safeClean = String(clean || "").trim();
  var classes = Array.isArray(schoolData.classes) ? schoolData.classes : [];
  var teachers = Array.isArray(schoolData.teachers) ? schoolData.teachers : [];
  var dayFilter = parseDayFilter(safeClean);

  // 1. Kiểm tra Lớp học (Chính xác 100%, chống 6A10 ra 6A1)
  var matchedClass = findMatchingClass(safeText, classes);
  if (matchedClass) {
    return formatClassTimetableResponse(matchedClass, schoolData, dayFilter);
  }

  // 2. Kiểm tra Giáo viên (Chính xác 100%, chống P.Thúy ra Thu)
  var matchedTeacher = findMatchingTeacher(safeText, teachers);
  if (matchedTeacher) {
    var isTomorrow = (safeClean.indexOf("mai") !== -1);
    if (isTomorrow) {
      return generateTomorrowTeacherMessage(matchedTeacher, schoolData);
    }
    return formatTeacherTimetableResponse(matchedTeacher, schoolData, dayFilter);
  }

  // 3. Nếu người dùng chỉ gõ "tkb" nhưng chưa liên kết SĐT
  if (safeClean.indexOf("tkb") === 0 || safeClean.indexOf("thoi khoa bieu") === 0 || safeClean.indexOf("lich day") === 0) {
    return "💡 Thầy/Cô vui lòng nhập đúng Tên viết tắt (VD: \"tkb Trọng\", \"tkb P.Thúy\") hoặc Tên lớp (VD: \"tkb 6A1\", \"tkb 9B2\").\n\n" +
           "📱 Nếu Thầy/Cô là Giáo viên: Hãy gửi [Số Điện Thoại] để kích hoạt nhận lịch dạy tự động lúc 6h00 sáng!";
  }

  return null;
}

function handleSubstitutionQuery(schoolData) {
  if (!schoolData || typeof schoolData !== "object") return "❌ Không thể kết nối cơ sở dữ liệu thời khóa biểu.";
  var subs = Array.isArray(schoolData.substitutions) ? schoolData.substitutions : [];
  if (subs.length === 0) {
    return "🔄 LỊCH DẠY THAY & HỌC THAY\n✨ Hiện tại không có ca dạy thay / học thay nào trong tuần này.";
  }

  var out = "🔄 LỊCH DẠY THAY & HỌC THAY\n📌 Cập nhật danh sách phân công dạy thay:\n\n";

  subs.forEach(function(s, idx) {
    if (!s || typeof s !== "object") return;
    out += (idx + 1) + ". Ngày " + (s.date || s.day || "Trong tuần") + " - Tiết " + (s.period || "") + "\n" +
           "• Lớp: " + (s.className || "") + " | Môn: " + (s.subject || "") + "\n" +
           "• GV vắng: " + (s.originalTeacher || "N/A") + "\n" +
           "• 👉 GV DẠY THAY: " + (s.substituteTeacher || "Chưa phân công") + "\n" +
           (s.note ? ("• Ghi chú: " + s.note + "\n") : "") + "\n";
  });

  return out.trim();
}

function handleFindFreeTeacherQuery(text, clean, schoolData) {
  if (!schoolData || typeof schoolData !== "object") return "❌ Không thể kết nối cơ sở dữ liệu trường.";

  var teachers = Array.isArray(schoolData.teachers) ? schoolData.teachers : [];
  var classes = Array.isArray(schoolData.classes) ? schoolData.classes : [];
  var active = getActiveTimetable(schoolData) || {};
  var timetable = (active && active.timetable && typeof active.timetable === "object") ? active.timetable : {};

  var safeClean = String(clean || "").trim();
  var rawStr = (text ? String(text) : "") + " " + safeClean;
  var normalizedSearch = typeof removeVietnameseTones === "function" ? removeVietnameseTones(rawStr).toLowerCase() : rawStr.toLowerCase();

  var day = parseDayFilter(safeClean) || "T2";
  var period = 1;
  var pMatch = normalizedSearch.match(/(?:tiet|t)\s*(\d{1,2})/);
  if (pMatch && pMatch[1]) {
    var parsedP = parseInt(pMatch[1], 10);
    if (!isNaN(parsedP) && parsedP >= 1 && parsedP <= 12) {
      period = parsedP;
    }
  }

  var freeTeachers = [];
  teachers.forEach(function(t) {
    if (!t || typeof t !== "object" || !t.shortName) return;
    var tShortName = String(t.shortName).trim();
    var isBusy = false;
    classes.forEach(function(c) {
      if (!c || typeof c !== "object" || !c.name) return;
      var cName = String(c.name).trim();
      var cSchedule = (Object.prototype.hasOwnProperty.call(timetable, cName) && timetable[cName] && typeof timetable[cName] === "object") ? timetable[cName] : null;
      if (cSchedule && Object.prototype.hasOwnProperty.call(cSchedule, day) && cSchedule[day] && typeof cSchedule[day] === "object") {
        var dayPeriods = cSchedule[day];
        if (Object.prototype.hasOwnProperty.call(dayPeriods, period) && dayPeriods[period] && typeof dayPeriods[period] === "object") {
          if (String(dayPeriods[period].teacher || "").trim() === tShortName) {
            isBusy = true;
          }
        }
      }
    });
    if (!isBusy) {
      freeTeachers.push(t);
    }
  });

  var dayNames = { "T2": "Thứ Hai", "T3": "Thứ Ba", "T4": "Thứ Tư", "T5": "Thứ Năm", "T6": "Thứ Sáu", "T7": "Thứ Bảy" };
  var dayLabel = escapeZaloMarkdown(dayNames[day] || day);
  var out = "👥 GIÁO VIÊN TRỐNG TIẾT DẠY THAY\n" +
            "🗓️ Thời gian: " + dayLabel + " - Tiết " + period + "\n\n";

  if (freeTeachers.length === 0) {
    out += "⚠️ Rất tiếc, không có giáo viên nào đang trống ở Tiết " + period + " " + dayLabel + ".";
  } else {
    out += "✅ Tìm thấy " + freeTeachers.length + " Giáo viên đang TRỐNG TIẾT có thể phân công dạy thay:\n\n";
    freeTeachers.forEach(function(t, i) {
      var groupStr = t.group ? (" - Tổ: " + escapeZaloMarkdown(String(t.group).replace(/^g_/, "Tổ ").replace(/_/g, " "))) : "";
      var tName = escapeZaloMarkdown(String(t.fullName || t.shortName || "").trim());
      var tShort = escapeZaloMarkdown(String(t.shortName || "").trim());
      out += (i + 1) + ". 👤 " + tName + " (" + tShort + ")" + groupStr + "\n";
    });
  }

  return out;
}

function handleNewTimetableAnnouncement(schoolData) {
  if (!schoolData || typeof schoolData !== "object") return "❌ Không thể kết nối cơ sở dữ liệu thời khóa biểu.";
  var active = getActiveTimetable(schoolData) || {};
  var weekName = escapeZaloMarkdown(String(active.weekName || "Thời khóa biểu chính thức").trim());
  var applyDate = escapeZaloMarkdown(String(active.applyDate || "Toàn trường").trim());
  var portalUrl = (CONFIG && typeof CONFIG.PUBLIC_TKB_PORTAL === "string") ? CONFIG.PUBLIC_TKB_PORTAL.trim() : "";
  var safePortalUrl = "";
  if (/^https?:\/\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=]+$/.test(portalUrl)) {
    safePortalUrl = portalUrl;
  }
  var msg = "📢 THÔNG BÁO THỜI KHÓA BIỂU\n" +
         "📌 Đợt TKB: " + weekName + "\n" +
         "🗓️ Áp dụng từ: " + applyDate + "\n\n" +
         "Thầy/Cô và các em học sinh có thể tra cứu nhanh bằng cách gõ:\n" +
         "👉 tkb [Tên Lớp hoặc Tên GV]\n";
  if (safePortalUrl) {
    msg += "\n🌐 Hoặc xem bảng trực tuyến 1 chạm tại:\n" + safePortalUrl + "?tra-cuu";
  }
  return msg;
}

// ====================================================================================================
// 🔗 12. HÀM MAPPING SỐ ĐIỆN THOẠI -> ZALO CHAT ID BẢO MẬT (DEFECT-ZALO-04)
// ====================================================================================================
function handleSecurePhoneMapping(chatId, phoneInput, secretPin) {
  var ss;
  try {
    ss = getDatabaseSpreadsheet();
  } catch (errSs) {
    Logger.log("⚠️ [SecurePhoneMapping] Lỗi getDatabaseSpreadsheet: " + errSs);
    return "⚠️ Không thể kết nối cơ sở dữ liệu.";
  }
  if (!ss) return "⚠️ Không mở được cơ sở dữ liệu.";
  var sheet = ss.getSheetByName(CONFIG.SHEET_USERS);
  if (!sheet) return "⚠️ Không tìm thấy bảng 'Danh bạ GV'.";

  var data;
  try {
    data = sheet.getDataRange().getValues();
  } catch (errData) {
    Logger.log("⚠️ [SecurePhoneMapping] Lỗi đọc dữ liệu sheet: " + errData);
    return "⚠️ Lỗi truy xuất danh bạ giáo viên.";
  }
  if (!Array.isArray(data)) return "⚠️ Dữ liệu danh bạ không hợp lệ.";

  var cleanPhoneInput = String(phoneInput || "").trim().slice(0, 20);
  var normPhone = normalizePhone(cleanPhoneInput);
  var matchedRow = -1;
  var teacherName = "";
  var department = "";
  var storedPin = "";

  for (var i = 1; i < data.length; i++) {
    if (!Array.isArray(data[i])) continue;
    var rawRowPhone = String(data[i][2] || "").trim();
    if (rawRowPhone && normalizePhone(rawRowPhone) === normPhone) {
      matchedRow = i + 1;
      teacherName = String(data[i][1] || "");
      department = String(data[i][3] || "");
      var rawPinVal = data[i][8];
      storedPin = (rawPinVal !== undefined && rawPinVal !== null) ? String(rawPinVal).replace(/^'+/, "").trim() : ""; // Cột 9: Mã PIN bí mật
      break;
    }
  }

  if (matchedRow === -1) {
    var safePhoneDisplay = "";
    if (normPhone && normPhone.length >= 7) {
      safePhoneDisplay = normPhone.substring(0, 3) + "****" + normPhone.substring(normPhone.length - 3);
    } else {
      safePhoneDisplay = escapeZaloMarkdown(cleanPhoneInput.slice(0, 15));
    }
    return "⚠️ Số điện thoại [" + safePhoneDisplay + "] không có trong danh bạ trường THCS Chu Văn An.\n\nThầy/Cô vui lòng liên hệ Ban Quản trị nhà trường để kiểm tra cập nhật số điện thoại.";
  }

  // Phòng thủ đa tầng cho Mã PIN:
  // Nếu storedPin trên Sheet bị lưu số đơn lẻ (7 -> 0007 do Google Sheet ép kiểu số), tự động bù padStart(4, '0')
  if (storedPin && /^\d+$/.test(storedPin) && storedPin.length < 4) {
    storedPin = ("0000" + storedPin).slice(-4);
  }

  // Chuẩn hóa PIN người dùng gửi: loại bỏ dấu nháy, tự động padStart(4, '0') nếu là số < 4 chữ số
  var pinClean = String(secretPin || "").replace(/^'+/, "").trim();
  if (pinClean && /^\d+$/.test(pinClean) && pinClean.length < 4) {
    pinClean = ("0000" + pinClean).slice(-4);
  }

  // Bắt buộc đối soát khớp chính xác secretPin === storedPin, loại bỏ hoàn toàn fallback bypass bằng 4 số cuối SĐT
  if (!storedPin || pinClean !== storedPin) {
    return "❌ Mã PIN bảo mật không chính xác!\n\n💡 Vui lòng kiểm tra Mã PIN tại mục 'Thông tin cá nhân & Zalo' trên trang web EduSign của trường hoặc liên hệ Quản trị viên.";
  }

  sheet.getRange(matchedRow, 6).setValue(String(chatId));
  sheet.getRange(matchedRow, 7).setValue(new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }));

  // Cơ chế Tự phục hồi dữ liệu (Self-Healing): Tự động chuẩn hóa lại SĐT và Mã PIN trên Google Sheet nếu bị mất số 0
  try {
    var cellPhone = sheet.getRange(matchedRow, 3);
    if (typeof cellPhone.setNumberFormat === 'function') cellPhone.setNumberFormat("@");
    if (normPhone) {
      var currentPhone = String(data[matchedRow - 1][2] || "");
      if (currentPhone !== normPhone && currentPhone !== ("'" + normPhone)) {
        cellPhone.setValue("'" + normPhone);
      }
    }
    if (storedPin) {
      var cellPin = sheet.getRange(matchedRow, 9);
      if (typeof cellPin.setNumberFormat === 'function') cellPin.setNumberFormat("@");
      var currentPin = String(data[matchedRow - 1][8] || "");
      if (currentPin !== storedPin && currentPin !== ("'" + storedPin)) {
        cellPin.setValue("'" + storedPin);
      }
    }
  } catch (eHeal) {
    Logger.log("⚠️ [SecurePhoneMapping] Self-healing warning: " + eHeal);
  }

  return "🎉 LIÊN KẾT ZALO THÀNH CÔNG!\n\n" +
         "👤 Thầy/Cô: " + escapeZaloMarkdown(teacherName) + "\n" +
         "🏫 Đơn vị: " + escapeZaloMarkdown(department) + "\n" +
         "📱 Số điện thoại: " + escapeZaloMarkdown(normPhone || cleanPhoneInput) + "\n" +
         "⏰ Đã kích hoạt: Nhận nhắc Lịch dạy 6h00 sáng & Thông báo duyệt ký số giáo án!";
}

// ====================================================================================================
// 📋 12.1 TRA CỨU HỒ SƠ THEO MÃ ĐỊNH DANH (DEFECT-ZALO-02)
// ====================================================================================================
function handleLookupSpecificDocument(chatId, docId) {
  if (!chatId) {
    return "⚠️ Thiếu định danh người dùng. Vui lòng nhắn tin trực tiếp từ tài khoản Zalo đã liên kết!";
  }
  var teacher;
  try {
    teacher = getTeacherProfileByChatId(chatId);
  } catch (errTeacher) {
    Logger.log("⚠️ [LookupDoc] Lỗi getTeacherProfileByChatId: " + errTeacher);
  }
  if (!teacher) {
    return "⚠️ Thầy/Cô chưa liên kết tài khoản Zalo. Vui lòng gửi [Số điện thoại] và [Mã PIN] để liên kết trước khi tra cứu!";
  }

  var targetId = String(docId || "").trim().toUpperCase();
  if (!targetId) {
    return "⚠️ Mã hồ sơ không hợp lệ. Thầy/Cô vui lòng cung cấp mã hồ sơ cần tra cứu.";
  }
  var ss;
  try {
    ss = getDatabaseSpreadsheet();
  } catch (errSs) {
    Logger.log("⚠️ [LookupDoc] Lỗi getDatabaseSpreadsheet: " + errSs);
    return "⚠️ Cơ sở dữ liệu chưa sẵn sàng.";
  }
  if (!ss) return "⚠️ Cơ sở dữ liệu chưa sẵn sàng.";

  var sheetName = (CONFIG && CONFIG.SHEET_REPORTS) ? CONFIG.SHEET_REPORTS : "Reports";
  var sheet;
  try {
    sheet = ss.getSheetByName(sheetName);
  } catch (errSheet) {
    Logger.log("⚠️ [LookupDoc] Lỗi getSheetByName: " + errSheet);
    return "⚠️ Lỗi kết nối sổ báo cáo.";
  }
  if (!sheet) return "⚠️ Không tìm thấy sổ báo cáo.";

  var data;
  try {
    data = sheet.getDataRange().getValues();
  } catch (errData) {
    Logger.log("⚠️ [LookupDoc] Lỗi đọc dữ liệu sheet: " + errData);
    return "⚠️ Lỗi truy xuất cơ sở dữ liệu báo cáo.";
  }
  if (!Array.isArray(data)) return "⚠️ Dữ liệu báo cáo không hợp lệ.";

  var foundDoc = null;

  for (var i = 1; i < data.length; i++) {
    if (!Array.isArray(data[i])) continue;
    var col0 = String(data[i][0] || "").trim().toUpperCase();
    var col1 = String(data[i][1] || "").trim().toUpperCase();
    if ((col0 && col0 === targetId) || (col1 && col1 === targetId)) {
      if (col0 === targetId) {
        foundDoc = {
          id: data[i][0],
          title: data[i][1],
          author: data[i][2],
          dept: data[i][4],
          approver: data[i][5],
          signedDate: data[i][6],
          status: data[i][7],
          viewUrl: data[i][8]
        };
      } else {
        foundDoc = {
          id: data[i][1],
          title: data[i][2],
          dept: data[i][3],
          author: data[i][4],
          approver: data[i][5],
          status: data[i][6],
          signedDate: data[i][7],
          viewUrl: data[i][8]
        };
      }
      break;
    }
  }

  if (!foundDoc) {
    var safeDocId = escapeZaloMarkdown(targetId.slice(0, 30));
    return "🔍 Không tìm thấy hồ sơ có mã: [" + safeDocId + "].\nThầy/Cô vui lòng kiểm tra lại mã trên hệ thống EduSign!";
  }

  // Kiểm tra quyền truy cập hồ sơ theo vai trò và đơn vị đã xác thực
  var docAuthor = String(foundDoc.author || "").trim().toLowerCase();
  var docApprover = String(foundDoc.approver || "").trim().toLowerCase();
  var docDept = String(foundDoc.dept || "").trim().toLowerCase();
  var teacherFull = String(teacher.fullName || "").trim().toLowerCase();
  var teacherShort = String(teacher.shortName || "").trim().toLowerCase();
  var teacherDept = String(teacher.department || "").trim().toLowerCase();

  var isAuthor = Boolean((teacherFull && docAuthor === teacherFull) || (teacherShort && docAuthor === teacherShort));
  var isApprover = Boolean((teacherFull && docApprover === teacherFull) || (teacherShort && docApprover === teacherShort));
  var isSameDept = Boolean(teacherDept && docDept && teacherDept === docDept);
  var bghRoles = ["bgh", "ban giám hiệu", "bgh - ban giám hiệu", "quản trị", "admin"];
  var isBGH = bghRoles.indexOf(teacherDept) !== -1;

  if (!isAuthor && !isApprover && !isSameDept && !isBGH) {
    return "⛔ Thầy/Cô không có quyền truy cập hồ sơ này. Chỉ tác giả, người duyệt, tổ bộ môn hoặc Ban Giám Hiệu mới có thể xem chi tiết hồ sơ.";
  }

  var safeViewUrl = "";
  if (foundDoc.viewUrl && /^https?:\/\/[a-zA-Z0-9\-._~:/?#[\]@!$&'()*+,;=]+$/.test(String(foundDoc.viewUrl).trim())) {
    safeViewUrl = String(foundDoc.viewUrl).trim();
  }

  return "╔════════════════════════════════════════╗\n" +
         "  📋 THÔNG TIN HỒ SƠ: " + escapeZaloMarkdown(String(foundDoc.id || targetId)) + "\n" +
         "╚════════════════════════════════════════╝\n\n" +
         "📄 Tên: " + escapeZaloMarkdown(String(foundDoc.title || "Chưa có tên")) + "\n" +
         "🏫 Đơn vị: " + escapeZaloMarkdown(String(foundDoc.dept || "Toàn trường")) + "\n" +
         "👤 Tác giả: " + escapeZaloMarkdown(String(foundDoc.author || "Giáo viên")) + "\n" +
         "✍️ Người duyệt: " + escapeZaloMarkdown(String(foundDoc.approver || "Chờ duyệt")) + "\n" +
         "📊 Trạng thái: " + escapeZaloMarkdown(String(foundDoc.status || "Đang xử lý")) + "\n" +
         "⏰ Ngày ký: " + escapeZaloMarkdown(String(foundDoc.signedDate || "Chưa ký")) + "\n\n" +
         (safeViewUrl ? ("📂 Tải tệp đã ký:\n👉 " + safeViewUrl) : "📌 Hồ sơ chưa hoàn tất ký số.");
}

// ====================================================================================================
// ⏳ 12.2 TRA CỨU DANH SÁCH HỒ SƠ CHỜ DUYỆT (DEFECT-ZALO-03)
// ====================================================================================================
function handleLookupPendingDocuments(chatId) {
  if (!chatId) {
    return "⚠️ Thiếu định danh người dùng. Vui lòng nhắn tin trực tiếp từ tài khoản Zalo đã liên kết!";
  }
  var teacher;
  try {
    teacher = getTeacherProfileByChatId(chatId);
  } catch (errTeacher) {
    Logger.log("⚠️ [LookupPending] Lỗi getTeacherProfileByChatId: " + errTeacher);
  }
  if (!teacher || typeof teacher !== "object") {
    return "⚠️ Thầy/Cô chưa liên kết tài khoản. Vui lòng nhắn SĐT để liên kết trước!";
  }

  var ss;
  try {
    ss = getDatabaseSpreadsheet();
  } catch (errSs) {
    Logger.log("⚠️ [LookupPending] Lỗi getDatabaseSpreadsheet: " + errSs);
    return "⚠️ Cơ sở dữ liệu chưa sẵn sàng.";
  }
  if (!ss) return "⚠️ Sổ báo cáo chưa được khởi tạo.";

  var sheetName = (CONFIG && CONFIG.SHEET_REPORTS) ? CONFIG.SHEET_REPORTS : "Reports";
  var sheet;
  try {
    sheet = ss.getSheetByName(sheetName);
  } catch (errSheet) {
    Logger.log("⚠️ [LookupPending] Lỗi getSheetByName: " + errSheet);
    return "⚠️ Lỗi truy xuất sổ báo cáo.";
  }
  if (!sheet) return "⚠️ Sổ báo cáo chưa được khởi tạo.";

  var data;
  try {
    data = sheet.getDataRange().getValues();
  } catch (errData) {
    Logger.log("⚠️ [LookupPending] Lỗi đọc dữ liệu sheet: " + errData);
    return "⚠️ Lỗi truy xuất danh sách báo cáo.";
  }
  if (!Array.isArray(data)) return "⚠️ Dữ liệu báo cáo không hợp lệ.";

  var teacherDept = String(teacher.department || "").trim().toLowerCase();
  var bghRoles = ["bgh", "ban giám hiệu", "bgh - ban giám hiệu", "quản trị", "admin"];
  var isBGH = bghRoles.indexOf(teacherDept) !== -1;
  var teacherFull = String(teacher.fullName || "").trim().toLowerCase();
  var teacherShort = String(teacher.shortName || "").trim().toLowerCase();

  var pendingList = [];
  for (var i = 1; i < data.length; i++) {
    if (!Array.isArray(data[i])) continue;
    var status = String(data[i][7] || data[i][6] || "").toUpperCase();
    if (status.indexOf("CHỜ") !== -1 || status.indexOf("WAITING") !== -1 || status.indexOf("SUBMITTED") !== -1) {
      var docAuthor = String(data[i][2] || data[i][4] || "").trim().toLowerCase();
      var docApprover = String(data[i][5] || "").trim().toLowerCase();
      var docDept = String(data[i][4] || data[i][3] || "").trim().toLowerCase();

      var canView = isBGH ||
                    (teacherDept && docDept && teacherDept === docDept) ||
                    (teacherFull && (docAuthor === teacherFull || docApprover === teacherFull)) ||
                    (teacherShort && (docAuthor === teacherShort || docApprover === teacherShort));

      if (canView) {
        pendingList.push({
          id: String(data[i][0] || data[i][1] || ""),
          title: String(data[i][1] || data[i][2] || ""),
          author: String(data[i][2] || data[i][4] || ""),
          dept: String(data[i][4] || data[i][3] || "")
        });
      }
    }
  }

  if (pendingList.length === 0) {
    return "🎉 Hiện tại không có hồ sơ nào đang chờ duyệt! Tất cả hồ sơ đã được xử lý xong.";
  }

  var msg = "╔════════════════════════════════════════╗\n" +
            "  ⏳ DANH SÁCH HỒ SƠ ĐANG CHỜ DUYỆT (" + pendingList.length + ")\n" +
            "╚════════════════════════════════════════╝\n\n";

  for (var k = 0; k < Math.min(pendingList.length, 5); k++) {
    msg += (k + 1) + ". [" + escapeZaloMarkdown(pendingList[k].id) + "] " + escapeZaloMarkdown(pendingList[k].title) + "\n" +
           "   👤 " + escapeZaloMarkdown(pendingList[k].author) + " (" + escapeZaloMarkdown(pendingList[k].dept || "Bộ môn") + ")\n\n";
  }

  msg += "👉 Kính mời Quý Thầy/Cô vào EduSign để phê duyệt.";
  return msg;
}

// ====================================================================================================
// 🔗 12. HÀM MAPPING SỐ ĐIỆN THOẠI -> ZALO CHAT ID
// ====================================================================================================
function handlePhoneMapping(chatId, phoneInput) {
  if (!chatId || !phoneInput) {
    return "⚠️ Thiếu thông tin liên kết số điện thoại. Vui lòng thử lại!";
  }
  var ss = getDatabaseSpreadsheet();
  if (!ss) {
    return "⚠️ Hệ thống không thể kết nối đến cơ sở dữ liệu. Vui lòng liên hệ Quản trị viên!";
  }
  var sheet = ss.getSheetByName(CONFIG.SHEET_USERS);
  if (!sheet) {
    return "⚠️ Hệ thống chưa tìm thấy bảng 'Danh bạ GV'. Vui lòng báo Quản trị viên!";
  }

  var data = sheet.getDataRange().getValues();
  if (!Array.isArray(data) || data.length === 0) {
    return "⚠️ Dữ liệu danh bạ giáo viên hiện đang trống.";
  }
  var normPhone = normalizePhone(phoneInput);
  var matchedRow = -1;
  var teacherName = "";
  var department = "";
  var shortName = "";

  for (var i = 1; i < data.length; i++) {
    if (!Array.isArray(data[i])) continue;
    var rowPhone = normalizePhone(String(data[i][2]));
    if (rowPhone === normPhone) {
      matchedRow = i + 1;
      teacherName = data[i][1];
      department = data[i][3];
      shortName = data[i][7] || "";
      break;
    }
  }

  if (matchedRow !== -1) {
    sheet.getRange(matchedRow, 6).setValue(String(chatId));
    sheet.getRange(matchedRow, 7).setValue(new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }));

    // Tự động tìm tên viết tắt TKB nếu chưa có
    if (!shortName) {
      try {
        var schoolData = fetchSchoolTimetableData();
        if (schoolData && schoolData.teachers) {
          var tObj = findMatchingTeacher(teacherName, schoolData.teachers);
          if (tObj && tObj.shortName) {
            sheet.getRange(matchedRow, 8).setValue(tObj.shortName);
          }
        }
      } catch (eFind) {
        // Bỏ qua lỗi tìm tên viết tắt, không làm gián đoạn liên kết
      }
    }

    return "🎉 LIÊN KẾT ZALO THÀNH CÔNG!\n\n" +
           "👤 Họ và Tên: " + escapeZaloMarkdown(teacherName) + "\n" +
           "🏫 Đơn vị: " + escapeZaloMarkdown(department) + "\n" +
           "📱 Số điện thoại: " + escapeZaloMarkdown(phoneInput) + "\n\n" +
           "✅ TỪ BÂY GIỜ THẦY/CÔ SẼ TỰ ĐỘNG NHẬN:\n" +
           "1️⃣ 🌅 Tin nhắn nhắc lịch giảng dạy chi tiết lúc 6h00 sáng mỗi ngày.\n" +
           "2️⃣ 🔔 Thông báo tức thì khi có hồ sơ trình ký, giáo án được ký duyệt hoặc bị trả về.\n" +
           "3️⃣ 📅 Tra cứu nhanh: Chỉ cần gõ 'tkb' là xem được lịch dạy cá nhân ngay lập tức!";
  } else {
    return "⚠️ Số điện thoại [" + escapeZaloMarkdown(phoneInput) + "] không có trong danh bạ cán bộ - giáo viên nhà trường.\n" +
           "Vui lòng kiểm tra lại hoặc liên hệ Văn thư nhà trường để cập nhật số điện thoại chính xác!";
  }
}

function handleUnlinkPhone(chatId) {
  if (!chatId) return "⚠️ Thiếu thông tin tài khoản Zalo.";
  var ss = getDatabaseSpreadsheet();
  if (!ss) return "⚠️ Hệ thống không thể kết nối đến cơ sở dữ liệu.";
  var sheet = ss.getSheetByName(CONFIG.SHEET_USERS);
  if (!sheet) return "⚠️ Dữ liệu chưa sẵn sàng.";

  var data = sheet.getDataRange().getValues();
  if (!Array.isArray(data)) return "⚠️ Dữ liệu không hợp lệ.";
  for (var i = 1; i < data.length; i++) {
    if (!Array.isArray(data[i])) continue;
    if (String(data[i][5]) === String(chatId)) {
      sheet.getRange(i + 1, 6).setValue("");
      return "✅ Đã hủy liên kết Zalo thành công. Thầy/Cô có thể gửi lại Số điện thoại mới bất cứ lúc nào.";
    }
  }
  return "⚠️ Tài khoản Zalo này chưa từng liên kết với số điện thoại nào.";
}

function getTeacherProfileByChatId(chatId) {
  if (!chatId) return null;
  var ss = getDatabaseSpreadsheet();
  if (!ss) return null;
  var sheet = ss.getSheetByName(CONFIG.SHEET_USERS);
  if (!sheet) return null;

  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (String(data[i][5]) === String(chatId)) {
      return {
        fullName: data[i][1],
        phone: normalizePhone(String(data[i][2])),
        department: data[i][3],
        shortName: data[i][7] || ""
      };
    }
  }
  return null;
}

// ====================================================================================================
// 📊 13. TRA CỨU TRẠNG THÁI HỒ SƠ 1-CHẠM QUA ZALO
// ====================================================================================================
function handleLookupTeacherReports(chatId) {
  if (!chatId) return "⚠️ Thiếu thông tin tài khoản Zalo.";
  var ss = getDatabaseSpreadsheet();
  if (!ss) return "⚠️ Hệ thống không thể kết nối đến cơ sở dữ liệu.";
  var sheetUsers = ss.getSheetByName(CONFIG.SHEET_USERS);
  var sheetReports = ss.getSheetByName(CONFIG.SHEET_REPORTS);

  if (!sheetUsers || !sheetReports) return "⚠️ Dữ liệu chưa sẵn sàng.";

  var teacher = getTeacherProfileByChatId(chatId);
  if (!teacher) {
    return "⚠️ Thầy/Cô chưa liên kết tài khoản Zalo!\n👉 Vui lòng gửi [Số Điện Thoại] để hệ thống kích hoạt trước khi tra cứu.";
  }

  var reportsData = sheetReports.getDataRange().getValues();
  if (!Array.isArray(reportsData)) return "⚠️ Dữ liệu báo cáo không hợp lệ.";
  var myReports = [];

  for (var j = reportsData.length - 1; j >= 1; j--) {
    var row = reportsData[j];
    if (!Array.isArray(row)) continue;
    var author = String(row[2] || "").trim();
    var phone = normalizePhone(String(row[3] || ""));

    if ((teacher.phone && phone === teacher.phone) || (teacher.fullName && author.toLowerCase().indexOf(teacher.fullName.toLowerCase()) !== -1)) {
      myReports.push({
        id: String(row[0] || ""),
        title: String(row[1] || ""),
        approver: String(row[5] || ""),
        date: String(row[6] || ""),
        status: String(row[7] || ""),
        viewUrl: String(row[8] || "")
      });
      if (myReports.length >= 5) break;
    }
  }

  if (myReports.length === 0) {
    return "📋 Kính chào Thầy/Cô " + escapeZaloMarkdown(teacher.fullName || "") + "!\n" +
           "Hiện tại chưa có báo cáo chuyên môn nào của Thầy/Cô được lưu trữ trên hệ thống.\n\n" +
           "🌐 Xem cổng báo cáo chung: " + CONFIG.PORTAL_URL;
  }

  var msg = "📋 CÁC BÁO CÁO GẦN NHẤT CỦA THẦY/CÔ (" + escapeZaloMarkdown(teacher.fullName || "") + "):\n";
  msg += "════════════════════════════════════════\n\n";

  for (var k = 0; k < myReports.length; k++) {
    var r = myReports[k];
    var statusIcon = (r.status === "ĐÃ KÝ DUYỆT & ĐÓNG DẤU" || r.status === "COMPLETED") ? "✅" : (r.status === "BỊ TRẢ VỀ" ? "⚠️" : "⏳");
    msg += (k + 1) + ". " + statusIcon + " " + escapeZaloMarkdown(r.title) + "\n";
    msg += "   • Trạng thái: " + escapeZaloMarkdown(r.status) + "\n";
    msg += "   • Ngày: " + escapeZaloMarkdown(r.date || "N/A") + "\n";
    if (r.viewUrl) msg += "   • Link xem: " + r.viewUrl + "\n";
    msg += "\n";
  }

  msg += "🌐 Tra cứu chi tiết tại: " + CONFIG.PORTAL_URL;
  return msg;
}

// ====================================================================================================
// 🔔 14. XỬ LÝ SỰ KIỆN TỪ SERVER KÝ SỐ EDUSIGN
// ====================================================================================================
function handleEduSignNotification(data) {
  if (!data || typeof data !== "object") {
    return {
      success: false,
      delivered: false,
      reason: "INVALID_PAYLOAD",
      error: "Payload không hợp lệ"
    };
  }
  const eventType = String(data.eventType || "");
  const docTitle = String(data.docTitle || "Báo cáo chuyên môn");
  const docId = String(data.docId || "");
  const authorPhone = normalizePhone(data.authorPhone || "");
  const recipientPhone = normalizePhone(data.recipientPhone || "");
  const recipientName = String(data.recipientName || "Người duyệt");
  const senderName = String(data.senderName || "Giáo viên");
  const approverName = String(data.approverName || "Ban Giám hiệu");
  const reason = String(data.reason || "");
  const viewUrl = String(data.viewUrl || CONFIG.PORTAL_URL);

  let messageText = "";
  let targetPhone = "";

  if (eventType === "REJECTED") {
    targetPhone = authorPhone;
    messageText = "╔════════════════════════════════════════╗\n" +
                  "  ⚠️ THÔNG BÁO: HỒ SƠ BỊ TRẢ VỀ\n" +
                  "╚════════════════════════════════════════╝\n\n" +
                  "📋 Hồ sơ: " + docTitle + "\n" +
                  "🆔 Mã hồ sơ: " + docId + "\n" +
                  "👤 Người trả về: " + approverName + "\n" +
                  "❌ Lý do trả về: \"" + reason + "\"\n" +
                  "⏰ Thời gian: " + new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) + "\n\n" +
                  "📌 Thầy/Cô vui lòng truy cập phần mềm EduSign để chỉnh sửa và nộp lại.";
  } else if (eventType === "COMPLETED") {
    targetPhone = authorPhone;
    const hasSchoolSeal = Boolean(data.hasSchoolSeal === true || data.isSchoolSeal === true);

    if (hasSchoolSeal) {
      // Trường hợp 3: Báo cáo cấp trường đã đóng dấu mộc đỏ pháp nhân hoàn tất
      messageText = "╔════════════════════════════════════════╗\n" +
                    "  🎉 THÔNG BÁO: HỒ SƠ ĐÃ ĐÓNG DẤU PHÁP NHÂN HOÀN TẤT\n" +
                    "╚════════════════════════════════════════╝\n\n" +
                    "📋 Báo cáo: " + docTitle + "\n" +
                    "🆔 Mã hồ sơ: " + docId + "\n" +
                    "✍️ Người ký duyệt: " + approverName + "\n" +
                    "🔴 Con dấu: Đã đóng mộc số của trường THCS Chu Văn An.\n" +
                    "⏰ Thời gian: " + new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) + "\n" +
                    (viewUrl ? ("📂 Link xem tài liệu: " + viewUrl + "\n\n") : "\n") +
                    "🌐 Tra cứu tại Cổng báo cáo: " + CONFIG.PORTAL_URL;
    } else {
      // Trường hợp 1: Báo cáo chuyên môn nội bộ đã được Tổ trưởng phê duyệt (KHÔNG có con dấu)
      messageText = "╔════════════════════════════════════════╗\n" +
                    "  🎉 THÔNG BÁO: BÁO CÁO NỘI BỘ ĐÃ PHÊ DUYỆT\n" +
                    "╚════════════════════════════════════════╝\n\n" +
                    "📋 Báo cáo: " + docTitle + "\n" +
                    "🆔 Mã hồ sơ: " + docId + "\n" +
                    "✍️ Người ký duyệt: " + approverName + "\n" +
                    "🏷️ Cấp phê duyệt: Nội bộ Tổ / Khối chuyên môn (Hoàn tất)\n" +
                    "⏰ Thời gian: " + new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) + "\n" +
                    (viewUrl ? ("📂 Link xem tài liệu: " + viewUrl + "\n\n") : "\n") +
                    "🌐 Tra cứu tại Cổng báo cáo: " + CONFIG.PORTAL_URL;
    }
  } else if (eventType === "BGH_APPROVED" || eventType === "PENDING_SEAL") {
    // Trường hợp 2: BGH đã phê duyệt báo cáo cá nhân, chờ đóng dấu mộc đỏ
    targetPhone = authorPhone;
    messageText = "╔════════════════════════════════════════╗\n" +
                  "  ✍️ THÔNG BÁO: BGH ĐÃ PHÊ DUYỆT BÁO CÁO\n" +
                  "╚════════════════════════════════════════╝\n\n" +
                  "📋 Báo cáo: " + docTitle + "\n" +
                  "🆔 Mã hồ sơ: " + docId + "\n" +
                  "✍️ Người phê duyệt: " + approverName + " — Ban Giám hiệu\n" +
                  "⏳ Trạng thái: Đã duyệt nội dung — Đang chờ đóng dấu mộc đỏ nhà trường.\n" +
                  "⏰ Thời gian: " + new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) + "\n\n" +
                  "📌 Hồ sơ sẽ chính thức hoàn tất sau khi Văn thư / BGH đóng dấu mộc số pháp nhân.";
  } else if (eventType === "SUBMITTED") {
    const nowStr = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });

    // Branch 1: Author Confirmation (authorPhone)
    let authorDelivered = false;
    const authorChatId = authorPhone ? getChatIdByPhone(authorPhone) : null;
    let authorNote = "";
    let replyAuthor = null;
    if (authorChatId) {
      const authorMsg = "╔════════════════════════════════════════╗\n" +
                      "  📤 XÁC NHẬN: KHỞI TẠO BÁO CÁO & TRÌNH KÝ THÀNH CÔNG\n" +
                      "╚════════════════════════════════════════╝\n\n" +
                      "📋 Tên hồ sơ: " + docTitle + "\n" +
                      "🆔 Mã hồ sơ: " + docId + "\n" +
                      "👤 Người tạo: " + senderName + "\n" +
                      "🔄 Luồng ký: Đã chuyển tiếp tới " + recipientName + " (" + (recipientPhone || "Chưa có SĐT") + ")\n" +
                      "⏰ Thời gian: " + nowStr + "\n\n" +
                      "📌 Hệ thống đã tự động ghi nhận và chuyển tiếp hồ sơ trong luồng ký số điện tử.";
      replyAuthor = sendZaloBotReply(authorChatId, authorMsg);
      if (replyAuthor && replyAuthor.success === true) {
        authorDelivered = true;
      } else {
        authorNote = (replyAuthor && replyAuthor.error) || "BOT_SEND_FAILED";
      }
    } else {
      authorNote = authorPhone ? "CHUA_LIEN_KET_ZALO" : "NO_AUTHOR_PHONE";
    }

    // Branch 2: Approver Invitation (recipientPhone)
    var recipientDelivered = false;
    var recipientChatId = recipientPhone ? getChatIdByPhone(recipientPhone) : null;
    var recipientNote = "";
    var replyApprover = null;
    if (recipientChatId) {
      var approverMsg = "╔════════════════════════════════════════╗\n" +
                        "  📥 THÔNG BÁO: CÓ HỒ SƠ MỚI CẦN KÝ DUYỆT\n" +
                        "╚════════════════════════════════════════╝\n\n" +
                        "📋 Tên hồ sơ: " + docTitle + "\n" +
                        "🆔 Mã hồ sơ: " + docId + "\n" +
                        "👤 Người trình ký: " + senderName + "\n" +
                        "⏰ Thời gian gửi: " + nowStr + "\n\n" +
                        "👉 Kính mời Quý Thầy/Cô vào phần mềm EduSign để kiểm tra và ký duyệt.";
      replyApprover = sendZaloBotReply(recipientChatId, approverMsg);
      if (replyApprover && replyApprover.success === true) {
        recipientDelivered = true;
      } else {
        recipientNote = (replyApprover && replyApprover.error) || "BOT_SEND_FAILED";
      }
    } else {
      // Graceful fallback: If recipientPhone is NOT linked to Zalo (!approverChatId), DO NOT crash or abort author's delivery!
      recipientNote = recipientPhone ? "CHUA_LIEN_KET_ZALO" : "NO_RECIPIENT_PHONE";
      Logger.log("ℹ️ [EduSign] Người duyệt (" + recipientPhone + ") chưa liên kết Zalo. Ghi nhận CHUA_LIEN_KET_ZALO.");
    }

    var isDelivered = Boolean(authorDelivered || recipientDelivered);

    if (!isDelivered && ((replyApprover && (replyApprover.success === false || replyApprover.statusCode)) || (replyAuthor && (replyAuthor.success === false || replyAuthor.statusCode)))) {
      var failedReply = (replyApprover && (replyApprover.success === false || replyApprover.statusCode)) ? replyApprover : replyAuthor;
      return {
        success: false,
        delivered: false,
        phone: recipientPhone || authorPhone,
        chatId: recipientChatId || authorChatId,
        statusCode: failedReply.statusCode,
        error: failedReply.error || "BOT_SEND_FAILED"
      };
    }

    return {
      success: true,
      eventType: "SUBMITTED",
      delivered: isDelivered,
      authorDelivered: authorDelivered,
      authorPhone: authorPhone,
      authorChatId: authorChatId,
      recipientDelivered: recipientDelivered,
      recipientPhone: recipientPhone,
      recipientChatId: recipientChatId,
      recipientNote: recipientNote,
      authorNote: authorNote,
      phone: recipientPhone || authorPhone,
      chatId: (recipientDelivered ? recipientChatId : (authorDelivered ? authorChatId : null)),
      note: isDelivered ? undefined : (recipientNote || authorNote || "CHUA_LIEN_KET_ZALO")
    };
  } else if (eventType === "PERSONAL_SIGNED") {
    targetPhone = authorPhone;
    messageText = "╔════════════════════════════════════════╗\n" +
                  "  ✅ XÁC NHẬN: KÝ SỐ GIÁO ÁN HOÀN TẤT\n" +
                  "╚════════════════════════════════════════╝\n\n" +
                  "📋 Giáo án: " + docTitle + "\n" +
                  "🆔 Mã hồ sơ: " + docId + "\n" +
                  "✍️ Tác giả: " + senderName + "\n" +
                  "⏰ Thời gian ký: " + new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" }) + "\n\n" +
                  "🎉 Hồ sơ cá nhân của Thầy/Cô đã được ký số hợp lệ và lưu trữ vào sổ sách điện tử.";
  } else if (eventType === "FORWARDED") {
    var nowStr = new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" });

    // Branch 1: Author Confirmation (authorPhone if available)
    var authorDelivered = false;
    var authorChatId = authorPhone ? getChatIdByPhone(authorPhone) : null;
    var authorNote = "";
    var replyAuthor = null;
    if (authorChatId) {
      var authorMsg = "╔════════════════════════════════════════╗\n" +
                      "  🔄 XÁC NHẬN: CHUYỂN TIẾP HỒ SƠ THÀNH CÔNG\n" +
                      "╚════════════════════════════════════════╝\n\n" +
                      "📋 Tên hồ sơ: " + docTitle + "\n" +
                      "🆔 Mã hồ sơ: " + docId + "\n" +
                      "👤 Người chuyển: " + senderName + "\n" +
                      "🔄 Chuyển tiếp tới: " + recipientName + " (" + (recipientPhone || "Chưa có SĐT") + ")\n" +
                      "⏰ Thời gian: " + nowStr + "\n\n" +
                      "📌 Hệ thống đã tự động ghi nhận và chuyển tiếp hồ sơ trong luồng ký số điện tử.";
      replyAuthor = sendZaloBotReply(authorChatId, authorMsg);
      if (replyAuthor && replyAuthor.success === true) {
        authorDelivered = true;
      } else {
        authorNote = (replyAuthor && replyAuthor.error) || "BOT_SEND_FAILED";
      }
    } else {
      authorNote = authorPhone ? "CHUA_LIEN_KET_ZALO" : "NO_AUTHOR_PHONE";
    }

    // Branch 2: Approver Invitation (recipientPhone)
    var recipientDelivered = false;
    var recipientChatId = recipientPhone ? getChatIdByPhone(recipientPhone) : null;
    var recipientNote = "";
    var replyApprover = null;
    if (recipientChatId) {
      var approverMsg = "╔════════════════════════════════════════╗\n" +
                        "  📥 THÔNG BÁO: HỒ SƠ CHUYỂN TIẾP CẦN KÝ DUYỆT\n" +
                        "╚════════════════════════════════════════╝\n\n" +
                        "📋 Tên hồ sơ: " + docTitle + "\n" +
                        "🆔 Mã hồ sơ: " + docId + "\n" +
                        "👤 Người chuyển tiếp: " + senderName + "\n" +
                        "⏰ Thời gian gửi: " + nowStr + "\n\n" +
                        "👉 Kính mời Thầy/Cô truy cập EduSign để kiểm tra và tiếp tục ký phối hợp.";
      replyApprover = sendZaloBotReply(recipientChatId, approverMsg);
      if (replyApprover && replyApprover.success === true) {
        recipientDelivered = true;
      } else {
        recipientNote = (replyApprover && replyApprover.error) || "BOT_SEND_FAILED";
      }
    } else {
      recipientNote = recipientPhone ? "CHUA_LIEN_KET_ZALO" : "NO_RECIPIENT_PHONE";
      Logger.log("ℹ️ [EduSign] Người duyệt tiếp theo (" + recipientPhone + ") chưa liên kết Zalo. Ghi nhận CHUA_LIEN_KET_ZALO.");
    }

    var isDelivered = Boolean(authorDelivered || recipientDelivered);

    if (!isDelivered && ((replyApprover && (replyApprover.success === false || replyApprover.statusCode)) || (replyAuthor && (replyAuthor.success === false || replyAuthor.statusCode)))) {
      var failedReply = (replyApprover && (replyApprover.success === false || replyApprover.statusCode)) ? replyApprover : replyAuthor;
      return {
        success: false,
        delivered: false,
        phone: recipientPhone || authorPhone,
        chatId: recipientChatId || authorChatId,
        statusCode: failedReply.statusCode,
        error: failedReply.error || "BOT_SEND_FAILED"
      };
    }

    return {
      success: true,
      eventType: "FORWARDED",
      delivered: isDelivered,
      authorDelivered: authorDelivered,
      authorPhone: authorPhone,
      authorChatId: authorChatId,
      recipientDelivered: recipientDelivered,
      recipientPhone: recipientPhone,
      recipientChatId: recipientChatId,
      recipientNote: recipientNote,
      authorNote: authorNote,
      phone: recipientPhone || authorPhone,
      chatId: (recipientDelivered ? recipientChatId : (authorDelivered ? authorChatId : null)),
      note: isDelivered ? undefined : (recipientNote || authorNote || "CHUA_LIEN_KET_ZALO")
    };
  }

  if (targetPhone && messageText) {
    var chatId = getChatIdByPhone(targetPhone);
    if (chatId) {
      // Khắc phục DEFECT-ZALO-12: Bắt mã phản hồi HTTP và xử lý lỗi mạng thực tế
      var replyResult = sendZaloBotReply(chatId, messageText);
      if (replyResult && replyResult.success === false) {
        return { 
          success: false, 
          delivered: false, 
          phone: targetPhone, 
          chatId: chatId, 
          statusCode: replyResult.statusCode, 
          error: replyResult.error || "BOT_SEND_FAILED" 
        };
      }
      return { success: true, delivered: true, phone: targetPhone, chatId: chatId };
    } else {
      return { success: true, delivered: false, phone: targetPhone, note: "CHUA_LIEN_KET_ZALO" };
    }
  }

  return { success: false, reason: "INVALID_EVENT" };
}

function sanitizeSpreadsheetText(val) {
  var s = String(val || "").trim();
  if (/^[=+\-@]/.test(s)) {
    return "'" + s;
  }
  return s;
}

// ====================================================================================================
// 👥 14.1 TỰ ĐỘNG ĐỒNG BỘ THÔNG TIN GIÁO VIÊN VÀO GOOGLE SHEET "Danh bạ GV" & MÃ PIN
// ====================================================================================================
function handleSyncTeacher(postData) {
  if (!postData || typeof postData !== "object") {
    return { success: false, error: "Payload thông tin giáo viên không hợp lệ" };
  }
  try {
    var ss = getDatabaseSpreadsheet();
    if (!ss) {
      return { success: false, error: "Không mở được cơ sở dữ liệu Google Sheet" };
    }

    var sheetUsers = ss.getSheetByName(CONFIG.SHEET_USERS);
    if (!sheetUsers) {
      initSheetsIfMissing();
      sheetUsers = ss.getSheetByName(CONFIG.SHEET_USERS);
    }
    if (!sheetUsers) {
      return { success: false, error: "Không tìm thấy Sheet Danh bạ GV" };
    }

    // Đảm bảo tiêu đề cột 9 là "Mã PIN"
    var headerRow = sheetUsers.getRange(1, 1, 1, Math.max(sheetUsers.getLastColumn(), 9)).getValues()[0];
    if (!headerRow || !headerRow[8] || String(headerRow[8]).trim() === "") {
      sheetUsers.getRange(1, 9).setValue("Mã PIN")
        .setBackground("#1e40af")
        .setFontColor("#ffffff")
        .setFontWeight("bold");
    }

    var rawT = (postData && typeof postData.teacher === "object" && postData.teacher !== null) ? postData.teacher : postData;
    var t = (rawT && typeof rawT === "object") ? rawT : {};
    var fullName = String(t.fullName || t.name || "").trim();
    var phone = String(t.phone || "").trim();
    var department = String(t.department || t.departmentName || "").trim();
    var email = String(t.email || "").trim();
    var rawPin = String(t.pinCode || t.pin || "").replace(/^'+/, "").trim();
    var pinCode = rawPin;
    var shortName = String(t.shortName || t.tkbName || "").trim();

    if (!fullName && !phone) {
      return { success: false, error: "Thiếu thông tin Họ tên hoặc Số điện thoại giáo viên" };
    }

    // Tự động suy ra tên viết tắt TKB nếu chưa có (lấy từ cuối tên)
    if (!shortName && fullName) {
      var parts = fullName.split(/\s+/);
      shortName = parts[parts.length - 1];
    }

    // Chuẩn hóa SĐT và PIN bảo đảm giữ nguyên 100% số 0 ở đầu
    var normPhone = normalizePhone(phone);
    var finalPhone = normPhone || String(phone || "").replace(/^'+/, "").trim();

    if (!pinCode) {
      // Triệt tiêu mã PIN mặc định: Khởi tạo ngẫu nhiên bảo mật 6 chữ số từ nguồn entropy hệ thống (không dùng Date.now)
      var digits = "";
      for (var attempt = 0; attempt < 5 && digits.length < 6; attempt++) {
        var rawUuid = "";
        if (typeof Utilities !== "undefined" && typeof Utilities.getUuid === "function") {
          rawUuid = Utilities.getUuid();
        } else {
          try {
            var cryptoObj = typeof require === "function" ? require("crypto") : null;
            if (cryptoObj && typeof cryptoObj.randomBytes === "function") {
              rawUuid = cryptoObj.randomBytes(16).toString("hex");
            }
          } catch (eCrypto) {
            Logger.log("Crypto random note: " + eCrypto);
          }
        }
        digits += String(rawUuid || "").replace(/\D/g, "");
      }

      if (digits.length < 6) {
        return { success: false, error: "Không thể khởi tạo mã PIN ngẫu nhiên bảo mật. Vui lòng cung cấp pinCode hợp lệ!" };
      }
      pinCode = digits.slice(0, 6);
    }
    var pinClean = String(pinCode).replace(/^'+/, "").trim();
    if (/^\d+$/.test(pinClean) && pinClean.length < 4) {
      pinClean = pinClean.padStart(4, "0");
    }
    if (!/^\d{4,8}$/.test(pinClean)) {
      return { success: false, error: "Mã PIN không hợp lệ. PIN phải gồm từ 4 đến 8 chữ số!" };
    }

    if (!sheetUsers || typeof sheetUsers.getDataRange !== "function") {
      return { success: false, error: "Không tìm thấy Sheet Danh bạ GV hoặc bảng tính không hợp lệ" };
    }

    try {
      if (typeof sheetUsers.getRange === "function") {
        sheetUsers.getRange("C:C").setNumberFormat("@");
        sheetUsers.getRange("F:F").setNumberFormat("@");
        sheetUsers.getRange("I:I").setNumberFormat("@");
      }
    } catch (eFmt) {
      Logger.log("Format range note: " + eFmt);
    }

    var data = [];
    try {
      data = sheetUsers.getDataRange().getValues();
    } catch (eData) {
      Logger.log("Lỗi đọc dữ liệu sheetUsers: " + eData);
      return { success: false, error: "Không thể đọc dữ liệu từ bảng Danh bạ GV" };
    }
    if (!Array.isArray(data) || data.length === 0) {
      return { success: false, error: "Dữ liệu danh bạ giáo viên trống hoặc không hợp lệ" };
    }
    var matchedRow = -1;

    // 1. Tìm theo Số điện thoại trước
    if (finalPhone) {
      for (var i = 1; i < data.length; i++) {
        var rowPhone = normalizePhone(String(data[i][2]));
        if (rowPhone && rowPhone === finalPhone) {
          matchedRow = i + 1;
          break;
        }
      }
    }

    // 2. Nếu không khớp SĐT, tìm theo Họ và Tên chính xác
    if (matchedRow === -1 && fullName) {
      var lowerName = fullName.toLowerCase();
      for (var j = 1; j < data.length; j++) {
        var rowName = String(data[j][1] || "").trim().toLowerCase();
        if (rowName && rowName === lowerName) {
          matchedRow = j + 1;
          break;
        }
      }
    }

    if (matchedRow !== -1) {
      var safeFullName = sanitizeSpreadsheetText(fullName);
      var safeDept = sanitizeSpreadsheetText(department);
      var safeEmail = sanitizeSpreadsheetText(email);
      var safeShortName = sanitizeSpreadsheetText(shortName);

      // Cập nhật dòng đã có trong khối try-catch an toàn
      try {
        if (fullName) sheetUsers.getRange(matchedRow, 2).setValue(safeFullName);
        if (finalPhone) {
          var cellP = sheetUsers.getRange(matchedRow, 3);
          try { if (typeof cellP.setNumberFormat === "function") cellP.setNumberFormat("@"); } catch (e) { Logger.log("Cell format note: " + e); }
          cellP.setValue("'" + finalPhone);
        }
        if (department) sheetUsers.getRange(matchedRow, 4).setValue(safeDept);
        if (email) sheetUsers.getRange(matchedRow, 5).setValue(safeEmail);
        if (shortName) sheetUsers.getRange(matchedRow, 8).setValue(safeShortName);
        if (pinClean) {
          var cellPin = sheetUsers.getRange(matchedRow, 9);
          try { if (typeof cellPin.setNumberFormat === "function") cellPin.setNumberFormat("@"); } catch (e) { Logger.log("Cell format note: " + e); }
          cellPin.setValue("'" + pinClean);
        }

        Logger.log("✅ Đã cập nhật giáo viên dòng " + matchedRow + ": " + safeFullName + " (" + finalPhone + ") - PIN: [REDACTED]");
        return {
          success: true,
          action_performed: "UPDATED",
          row: matchedRow,
          message: "Cập nhật thành công thông tin giáo viên [" + safeFullName + "] trên Google Sheet"
        };
      } catch (eUpdate) {
        Logger.log("❌ Lỗi khi cập nhật ô giáo viên: " + eUpdate);
        return {
          success: false,
          error: "Lỗi ghi dữ liệu cập nhật giáo viên: " + (eUpdate && eUpdate.message ? eUpdate.message : String(eUpdate))
        };
      }
    } else {
      // Thêm mới dòng
      var safeFullNameNew = sanitizeSpreadsheetText(fullName);
      var safeDeptNew = sanitizeSpreadsheetText(department);
      var safeEmailNew = sanitizeSpreadsheetText(email);
      var safeShortNameNew = sanitizeSpreadsheetText(shortName);
      var newStt = Math.max(1, data.length);
      var phoneText = finalPhone ? ("'" + finalPhone) : "";
      var pinText = pinClean ? ("'" + pinClean) : "";
      sheetUsers.appendRow([
        newStt,
        safeFullNameNew,
        phoneText,
        safeDeptNew,
        safeEmailNew,
        "", // Zalo_Chat_ID ban đầu để trống (sẽ được điền khi GV gửi tin LK)
        "", // Ngày Liên Kết
        safeShortNameNew,
        pinText
      ]);
      try {
        var lastR = sheetUsers.getLastRow();
        if (typeof sheetUsers.getRange === "function") {
          sheetUsers.getRange(lastR, 3).setNumberFormat("@");
          sheetUsers.getRange(lastR, 6).setNumberFormat("@");
          sheetUsers.getRange(lastR, 9).setNumberFormat("@");
        }
      } catch (eRowFmt) {
        Logger.log("Row format note: " + eRowFmt);
      }

      Logger.log("✅ Đã thêm mới giáo viên vào Sheet: " + safeFullNameNew + " (" + finalPhone + ") - PIN: [REDACTED]");
      return {
        success: true,
        action_performed: "CREATED",
        row: data.length + 1,
        message: "Thêm mới thành công giáo viên [" + safeFullNameNew + "] vào Google Sheet"
      };
    }
  } catch (err) {
    Logger.log("❌ Lỗi đồng bộ giáo viên: " + err.message);
    return { success: false, error: err.message };
  }
}

function handleSyncTeachersBatch(postData) {
  if (!postData || typeof postData !== "object" || Array.isArray(postData)) {
    return { success: false, error: "Payload thông tin giáo viên hàng loạt không hợp lệ" };
  }
  try {
    var teachers = Array.isArray(postData.teachers) ? postData.teachers : [];
    if (teachers.length === 0) {
      return { success: false, error: "Danh sách giáo viên rỗng" };
    }
    if (teachers.length > 500) {
      return { success: false, error: "Số lượng giáo viên vượt quá giới hạn cho phép (tối đa 500)" };
    }
    var results = [];
    var hasFailure = false;
    for (var k = 0; k < teachers.length; k++) {
      var tItem = teachers[k];
      if (!tItem || typeof tItem !== "object" || Array.isArray(tItem)) {
        results.push({ success: false, index: k, error: "Dữ liệu giáo viên không hợp lệ tại vị trí " + k });
        hasFailure = true;
        continue;
      }
      var res = handleSyncTeacher({ teacher: tItem });
      if (!res || res.success !== true) {
        hasFailure = true;
      }
      results.push(res);
    }
    var passedCount = results.filter(function(r) { return r && r.success === true; }).length;
    var allPassed = (passedCount === teachers.length && !hasFailure);
    return {
      success: allPassed,
      total: teachers.length,
      passedCount: passedCount,
      failedCount: teachers.length - passedCount,
      details: results
    };
  } catch (err) {
    return { success: false, error: err.message };
  }
}

// ====================================================================================================
// 📁 15. LƯU TRỮ BÁO CÁO VÀO GOOGLE DRIVE & GOOGLE SHEETS
// ====================================================================================================
function handleReportArchive(data) {
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { success: false, error: "Payload lưu trữ báo cáo không hợp lệ" };
  }
  try {
    var safeData = (data && typeof data === "object" && !Array.isArray(data)) ? data : {};
    var ss = getDatabaseSpreadsheet();
    if (!ss) {
      return { success: false, error: "Không thể mở bảng tính cơ sở dữ liệu" };
    }
    var sheet = ss.getSheetByName(CONFIG.SHEET_REPORTS);
    if (!sheet) {
      return { success: false, error: "Khong tim thay Sheet So Luu Bao Cao" };
    }

    var rawDocId = String(safeData.docId || ("BC-" + Date.now())).trim().slice(0, 100);
    var docId = sanitizeSpreadsheetText(rawDocId);
    var rawTitle = String(safeData.title || "Báo cáo chuyên môn").trim().slice(0, 300);
    var title = sanitizeSpreadsheetText(rawTitle);
    var author = sanitizeSpreadsheetText(String(safeData.author || "Giáo viên").trim().slice(0, 150));
    var authorPhone = sanitizeSpreadsheetText(normalizePhone(safeData.authorPhone || ""));
    var department = sanitizeSpreadsheetText(String(safeData.department || "Tổ chuyên môn").trim().slice(0, 150));
    var approver = sanitizeSpreadsheetText(String(safeData.approver || "Ban Giám hiệu").trim().slice(0, 150));
    var signDate = sanitizeSpreadsheetText(String(safeData.signDate || new Date().toLocaleString("vi-VN", { timeZone: "Asia/Ho_Chi_Minh" })).trim().slice(0, 100));
    var status = sanitizeSpreadsheetText(String(safeData.status || "ĐÃ KÝ DUYỆT & ĐÓNG DẤU").trim().slice(0, 100));
    var note = sanitizeSpreadsheetText(String(safeData.note || "").trim().slice(0, 500));

    var fileBase64 = (typeof safeData.fileBase64 === "string") ? safeData.fileBase64.trim() : "";
    var rawFileName = (typeof safeData.fileName === "string" && safeData.fileName.trim().length > 0)
      ? safeData.fileName.trim()
      : (rawDocId + "_" + rawTitle.replace(/[^a-zA-Z0-9_\-\.\u00C0-\u024F\u1EA0-\u1EF9]/g, "_") + ".pdf");
    var fileName = rawFileName.replace(/[\\\/:\*\?"<>\|]/g, "_").slice(0, 150);
    if (!/\.(pdf|docx?|xlsx?|png|jpe?g)$/i.test(fileName)) {
      fileName += ".pdf";
    }

    var viewUrl = (typeof safeData.viewUrl === "string" && /^https?:\/\//i.test(safeData.viewUrl.trim())) ? safeData.viewUrl.trim().slice(0, 2000) : "";
    var downloadUrl = (typeof safeData.downloadUrl === "string" && /^https?:\/\//i.test(safeData.downloadUrl.trim())) ? safeData.downloadUrl.trim().slice(0, 2000) : "";

    var lock = (typeof LockService !== "undefined" && typeof LockService.getScriptLock === "function")
      ? LockService.getScriptLock()
      : null;
    var hasLock = false;
    if (lock) {
      try {
        hasLock = lock.tryLock(10000);
      } catch (eLock) {
        Logger.log("Lỗi acquire script lock: " + eLock.toString());
      }
      if (!hasLock) {
        return {
          success: false,
          error: "Hệ thống đang bận ghi nhận báo cáo đồng thời, vui lòng thử lại sau giây lát"
        };
      }
    }

    try {
      if (fileBase64 && (!viewUrl || viewUrl === "")) {
        // Giới hạn Base64 tương ứng tối đa 35MB nhị phân (35 * 1024 * 1024 * 4 / 3)
        var maxBase64Length = Math.floor(35 * 1024 * 1024 * 4 / 3);
        if (fileBase64.length > maxBase64Length) {
          return { success: false, error: "Dung lượng tệp đính kèm Base64 vượt quá giới hạn 35MB nhị phân" };
        }
        try {
          var rootFolder = getOrCreateFolderHierarchy(CONFIG.DRIVE_ROOT_FOLDER);
          var yearMonth = Utilities.formatDate(new Date(), "Asia/Ho_Chi_Minh", "yyyy/MM");
          var targetFolder = getOrCreateFolderHierarchy(CONFIG.DRIVE_ROOT_FOLDER + "/" + yearMonth);

          var extMatch = fileName.match(/\.([a-zA-Z0-9]+)$/);
          var fileExt = extMatch ? extMatch[1].toLowerCase() : "pdf";
          var mimeMap = {
            "pdf": "application/pdf",
            "docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            "doc": "application/msword",
            "xlsx": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
            "xls": "application/vnd.ms-excel",
            "png": "image/png",
            "jpg": "image/jpeg",
            "jpeg": "image/jpeg"
          };
          var fileMimeType = mimeMap[fileExt] || "application/pdf";

          var decodedBytes = Utilities.base64Decode(fileBase64);
          var blob = Utilities.newBlob(decodedBytes, fileMimeType, fileName);
          var driveFile = targetFolder.createFile(blob);
          try {
            if (safeData.isPublic === true && typeof DriveApp !== "undefined" && DriveApp.Access) {
              if (DriveApp.Access.DOMAIN_WITH_LINK) {
                driveFile.setSharing(DriveApp.Access.DOMAIN_WITH_LINK, DriveApp.Permission.VIEW);
              } else if (DriveApp.Access.ANYONE_WITH_LINK) {
                driveFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);
              }
            }
          } catch (eShare) {
            Logger.log("Lưu ý phân quyền chia sẻ Drive: " + eShare.toString());
          }

          viewUrl = driveFile.getUrl();
          downloadUrl = driveFile.getDownloadUrl();
        } catch (driveErr) {
          Logger.log("Lỗi tải tệp lên Drive: " + driveErr.toString());
        }
      }

      // Kiểm tra xem báo cáo docId này đã tồn tại trong Sheet hay chưa (tránh trùng lặp khi ký nhiều bước)
      var dataRows = (sheet && typeof sheet.getDataRange === "function") ? sheet.getDataRange().getValues() : [];
      var existingRowIndex = -1;
      if (Array.isArray(dataRows)) {
        for (var r = 1; r < dataRows.length; r++) {
          if (Array.isArray(dataRows[r]) && String(dataRows[r][0] || "").trim() === String(docId).trim()) {
            existingRowIndex = r + 1; // 1-indexed trong Google Sheets
            break;
          }
        }
      }

      var rowValues = [
        sanitizeSpreadsheetText(docId),
        sanitizeSpreadsheetText(title),
        sanitizeSpreadsheetText(author),
        sanitizeSpreadsheetText(authorPhone),
        sanitizeSpreadsheetText(department),
        sanitizeSpreadsheetText(approver),
        sanitizeSpreadsheetText(signDate),
        sanitizeSpreadsheetText(status),
        sanitizeSpreadsheetText(viewUrl),
        sanitizeSpreadsheetText(downloadUrl),
        sanitizeSpreadsheetText(note)
      ];

      if (existingRowIndex > 0) {
        // CẬP NHẬT đè lên dòng đã có: cập nhật trạng thái mới nhất, người duyệt mới nhất, ngày giờ mới nhất
        sheet.getRange(existingRowIndex, 1, 1, 11).setValues([rowValues]);
      } else {
        sheet.appendRow(rowValues);
      }

      return {
        success: true,
        docId: docId,
        viewUrl: viewUrl,
        downloadUrl: downloadUrl,
        updated: (existingRowIndex > 0),
        message: (existingRowIndex > 0) ? "Đã cập nhật trạng thái báo cáo thành công!" : "Lưu trữ báo cáo thành công!"
      };
    } finally {
      if (lock && hasLock) {
        try {
          lock.releaseLock();
        } catch (eRel) {
          Logger.log("Lỗi release lock: " + eRel.toString());
        }
      }
    }
  } catch (err) {
    return { success: false, error: err.toString() };
  }
}

function fetchReportsFromSheet(params) {
  try {
    params = (params && typeof params === "object" && !Array.isArray(params)) ? params : {};
    var ss = getDatabaseSpreadsheet();
    if (!ss) return { total: 0, page: 1, limit: 10, data: [] };
    var sheet = ss.getSheetByName(CONFIG.SHEET_REPORTS);
    if (!sheet) return { total: 0, page: 1, limit: 10, data: [] };

    var data = (typeof sheet.getDataRange === "function") ? sheet.getDataRange().getValues() : [];
    if (!Array.isArray(data)) return { total: 0, page: 1, limit: 10, data: [] };

    var search = String(params.search == null ? "" : params.search).toLowerCase().trim();
    var authorFilter = String(params.author == null ? "" : params.author).toLowerCase().trim();
    var deptFilter = String(params.dept == null ? "" : params.dept).toLowerCase().trim();
    var statusFilter = String(params.status == null ? "" : params.status).toLowerCase().trim();
    var rawPage = parseInt(params.page || "1", 10);
    var page = (!isNaN(rawPage) && rawPage > 0) ? rawPage : 1;
    var rawLimit = parseInt(params.limit || "10", 10);
    var limit = (!isNaN(rawLimit) && rawLimit > 0 && rawLimit <= 100) ? rawLimit : 10;

    // Bước 1: Trích xuất bản ghi mới nhất cho từng docId duy nhất (duyệt từ dưới lên trên)
    var seenDocIds = {};
    var latestReports = [];

    for (var i = data.length - 1; i >= 1; i--) {
      var row = data[i];
      if (!Array.isArray(row)) continue;
      var docId = String(row[0] || "").trim();
      if (!docId) continue;
      if (seenDocIds[docId]) continue; // Đã lấy bản ghi mới nhất ở dưới cùng
      seenDocIds[docId] = true;

      latestReports.push({
        docId: docId,
        title: String(row[1] || ""),
        author: String(row[2] || ""),
        authorPhone: String(row[3] || ""),
        department: String(row[4] || ""),
        approver: String(row[5] || ""),
        signDate: String(row[6] || ""),
        status: String(row[7] || ""),
        viewUrl: String(row[8] || ""),
        downloadUrl: String(row[9] || ""),
        note: String(row[10] || "")
      });
    }

    // Bước 2: Áp dụng các bộ lọc tìm kiếm trên danh sách bản ghi mới nhất
    var filtered = [];
    for (var j = 0; j < latestReports.length; j++) {
      var item = latestReports[j];
      if (search) {
        var combined = (item.docId + " " + item.title + " " + item.author + " " + item.approver).toLowerCase();
        if (combined.indexOf(search) === -1) continue;
      }
      if (authorFilter && item.author.toLowerCase().indexOf(authorFilter) === -1) continue;
      if (deptFilter && item.department.toLowerCase().indexOf(deptFilter) === -1) continue;
      if (statusFilter && item.status.toLowerCase().indexOf(statusFilter) === -1) continue;

      filtered.push(item);
    }

    var startIndex = (page - 1) * limit;
    var paginated = filtered.slice(startIndex, startIndex + limit);

    return {
      total: filtered.length,
      page: page,
      limit: limit,
      data: paginated
    };
  } catch (err) {
    Logger.log("Lỗi fetchReportsFromSheet: " + (err ? err.toString() : ""));
    return { total: 0, page: 1, limit: 10, data: [], error: "Không thể tải danh sách báo cáo" };
  }
}

/**
 * Xóa báo cáo khỏi Sheet lưu trữ (Chỉ dành cho Quản trị viên Admin)
 */
function deleteReportFromSheet(docId, authPayload) {
  var cleanDocId = String(docId || "").trim();
  if (!cleanDocId) {
    return { success: false, error: "Thiếu mã báo cáo docId" };
  }
  if (cleanDocId.length > 100) {
    return { success: false, error: "Mã báo cáo docId không hợp lệ" };
  }

  // Bắt buộc xác thực quyền Quản trị viên Admin
  var keyToVerify = (typeof authPayload === "string")
    ? authPayload
    : (authPayload && (authPayload.adminKey || authPayload.apiKey || authPayload.key)) || "";

  if (!verifyAdminApiKey(keyToVerify)) {
    return { success: false, error: "UNAUTHORIZED_ADMIN_ACTION" };
  }

  var lock = (typeof LockService !== "undefined" && typeof LockService.getScriptLock === "function")
    ? LockService.getScriptLock()
    : null;
  var hasLock = false;
  if (lock) {
    try {
      hasLock = lock.tryLock(10000);
    } catch (eLock) {
      Logger.log("Lỗi acquire script lock delete: " + eLock.toString());
    }
    if (!hasLock) {
      return { success: false, error: "Hệ thống đang bận xử lý dữ liệu đồng thời, vui lòng thử lại sau" };
    }
  }

  try {
    var ss = getDatabaseSpreadsheet();
    if (!ss) return { success: false, error: "Không thể mở cơ sở dữ liệu Spreadsheet" };
    var sheet = ss.getSheetByName(CONFIG.SHEET_REPORTS);
    if (!sheet) return { success: false, error: "Không tìm thấy Sheet Sổ Lưu Báo Cáo" };

    var data = (typeof sheet.getDataRange === "function") ? sheet.getDataRange().getValues() : [];
    if (!Array.isArray(data)) return { success: false, error: "Không thể đọc dữ liệu báo cáo" };

    var countDeleted = 0;
    // Lặp ngược từ dưới lên trên để xóa sạch tất cả dòng có cùng docId
    for (var i = data.length - 1; i >= 1; i--) {
      if (Array.isArray(data[i]) && String(data[i][0] || "").trim() === cleanDocId) {
        sheet.deleteRow(i + 1); // 1-indexed trong Google Sheets
        countDeleted++;
      }
    }

    if (countDeleted === 0) {
      return { success: false, error: "Không tìm thấy báo cáo có mã " + cleanDocId };
    }

    return {
      success: true,
      docId: cleanDocId,
      count: countDeleted,
      message: "Đã xóa " + countDeleted + " dòng báo cáo thành công khỏi kho lưu trữ!"
    };
  } catch (err) {
    Logger.log("Lỗi deleteReportFromSheet: " + (err ? err.toString() : ""));
    return { success: false, error: "Không thể xóa báo cáo" };
  } finally {
    if (lock && hasLock) {
      try {
        lock.releaseLock();
      } catch (eRel) {
        Logger.log("Lỗi release lock delete: " + eRel.toString());
      }
    }
  }
}

/**
 * Xóa nhiều báo cáo đã chọn cùng lúc
 */
function batchDeleteReportsFromSheet(docIds, authPayload) {
  if (!docIds || !Array.isArray(docIds) || docIds.length === 0) {
    return { success: false, error: "Danh sách mã báo cáo rỗng" };
  }
  if (docIds.length > 200) {
    return { success: false, error: "Số lượng báo cáo cần xóa vượt quá giới hạn (tối đa 200)" };
  }

  // Bắt buộc xác thực quyền Quản trị viên Admin
  var keyToVerifyBatch = (typeof authPayload === "string")
    ? authPayload
    : (authPayload && (authPayload.adminKey || authPayload.apiKey || authPayload.key)) || "";

  if (!verifyAdminApiKey(keyToVerifyBatch)) {
    return { success: false, error: "UNAUTHORIZED_ADMIN_ACTION" };
  }

  var lock = (typeof LockService !== "undefined" && typeof LockService.getScriptLock === "function")
    ? LockService.getScriptLock()
    : null;
  var hasLock = false;
  if (lock) {
    try {
      hasLock = lock.tryLock(15000);
    } catch (eLock) {
      Logger.log("Lỗi acquire script lock batch delete: " + eLock.toString());
    }
    if (!hasLock) {
      return { success: false, error: "Hệ thống đang bận xử lý dữ liệu đồng thời, vui lòng thử lại sau" };
    }
  }

  try {
    var ss = getDatabaseSpreadsheet();
    if (!ss) return { success: false, error: "Không thể mở cơ sở dữ liệu Spreadsheet" };
    var sheet = ss.getSheetByName(CONFIG.SHEET_REPORTS);
    if (!sheet) return { success: false, error: "Không tìm thấy Sheet Sổ Lưu Báo Cáo" };

    var data = (typeof sheet.getDataRange === "function") ? sheet.getDataRange().getValues() : [];
    if (!Array.isArray(data)) return { success: false, error: "Không thể đọc dữ liệu báo cáo" };

    var idMap = {};
    for (var k = 0; k < docIds.length; k++) {
      var cId = String(docIds[k] || "").trim();
      if (cId) idMap[cId] = true;
    }

    var countDeleted = 0;
    for (var i = data.length - 1; i >= 1; i--) {
      if (Array.isArray(data[i])) {
        var id = String(data[i][0] || "").trim();
        if (id && idMap[id]) {
          sheet.deleteRow(i + 1);
          countDeleted++;
        }
      }
    }

    return {
      success: true,
      count: countDeleted,
      message: "Đã xóa thành công " + countDeleted + " báo cáo được chọn!"
    };
  } catch (err) {
    Logger.log("Lỗi batchDeleteReportsFromSheet: " + (err ? err.toString() : ""));
    return { success: false, error: "Không thể xóa danh sách báo cáo" };
  } finally {
    if (lock && hasLock) {
      try {
        lock.releaseLock();
      } catch (eRel) {
        Logger.log("Lỗi release lock batch delete: " + eRel.toString());
      }
    }
  }
}

/**
 * Xóa toàn bộ kho báo cáo (Giữ lại dòng tiêu đề cột)
 */
function clearAllReportsFromSheet(authPayload) {
  // Bắt buộc xác thực quyền Quản trị viên Admin
  var keyToVerifyClear = (typeof authPayload === "string")
    ? authPayload
    : (authPayload && (authPayload.adminKey || authPayload.apiKey || authPayload.key)) || "";

  if (!verifyAdminApiKey(keyToVerifyClear)) {
    return { success: false, error: "UNAUTHORIZED_ADMIN_ACTION" };
  }

  var lock = (typeof LockService !== "undefined" && typeof LockService.getScriptLock === "function")
    ? LockService.getScriptLock()
    : null;
  var hasLock = false;
  if (lock) {
    try {
      hasLock = lock.tryLock(15000);
    } catch (eLock) {
      Logger.log("Lỗi acquire script lock clear: " + eLock.toString());
    }
    if (!hasLock) {
      return { success: false, error: "Hệ thống đang bận xử lý dữ liệu đồng thời, vui lòng thử lại sau" };
    }
  }

  try {
    var ss = getDatabaseSpreadsheet();
    if (!ss) return { success: false, error: "Không thể mở cơ sở dữ liệu Spreadsheet" };
    var sheet = ss.getSheetByName(CONFIG.SHEET_REPORTS);
    if (!sheet) return { success: false, error: "Không tìm thấy Sheet Sổ Lưu Báo Cáo" };

    var lastRow = sheet.getLastRow();
    if (lastRow > 1) {
      sheet.deleteRows(2, lastRow - 1);
    }

    return { success: true, message: "Đã xóa sạch toàn bộ kho dữ liệu báo cáo chuyên môn!" };
  } catch (err) {
    Logger.log("Lỗi clearAllReportsFromSheet: " + (err ? err.toString() : ""));
    return { success: false, error: "Không thể xóa sạch kho dữ liệu báo cáo" };
  } finally {
    if (lock && hasLock) {
      try {
        lock.releaseLock();
      } catch (eRel) {
        Logger.log("Lỗi release lock clear: " + eRel.toString());
      }
    }
  }
}

// ====================================================================================================
// 🛠️ 16. CÁC HÀM TIỆN ÍCH TRỢ GIÚP (HELPERS & NLP MATCHER ENGINE)
// ====================================================================================================
function getUnifiedWelcomeGuideText() {
  var schoolData = fetchSchoolTimetableData();
  var currentInfo = "";
  if (schoolData) {
    var active = getActiveTimetable(schoolData);
    if (active && active.weekName) {
      currentInfo = "\n📌 Đợt TKB: " + active.weekName + (active.applyDate ? " (từ " + active.applyDate + ")" : "");
    }
  }

  return "🏫 TRỢ LÝ THÔNG MINH THCS CHU VĂN AN 4.0\n" +
         "Chào mừng Quý Thầy/Cô và các em học sinh!" + currentInfo + "\n\n" +
         "📱 1. NHẬN LỊCH DẠY 6H00 SÁNG & KÝ SỐ:\n" +
         "👉 Gửi: [Số điện thoại]\n" +
         "   ↳ VD: 0818810007\n\n" +
         "🔹 2. TRA CỨU THỜI KHÓA BIỂU:\n" +
         "• tkb [Tên Lớp]\n" +
         "  ↳ VD: tkb 6a1\n" +
         "• tkb [Tên GV]\n" +
         "  ↳ VD: tkb Tý (hoặc tkb Trọng)\n" +
         "• tkb hôm nay\n" +
         "  ↳ Xem lịch dạy hôm nay\n" +
         "• tkb ngày mai\n" +
         "  ↳ Xem lịch dạy ngày mai\n\n" +
         "🔹 3. LỊCH DẠY THAY & GV TRỐNG TIẾT:\n" +
         "• day thay\n" +
         "  ↳ Xem ca phân công dạy thay\n" +
         "• tim gv t3\n" +
         "  ↳ Tìm GV rảnh tiết Thứ 3\n\n" +
         "🔹 4. HỒ SƠ & BÁO CÁO KÝ SỐ:\n" +
         "• hoso\n" +
         "  ↳ Tra cứu giáo án đã nộp\n" +
         "• baocao\n" +
         "  ↳ Cổng lưu trữ báo cáo số\n\n" +
         "🌐 Cổng TKB Online:\n" +
         CONFIG.PUBLIC_TKB_PORTAL + "\n\n" +
         "🌐 Cổng Báo Cáo Ký Số:\n" +
         CONFIG.PORTAL_URL;
}

/**
 * Tải dữ liệu thời khóa biểu từ Firebase Realtime Database
 * Bao gồm cơ chế bộ nhớ đệm CacheService, timeout và xử lý ngoại lệ chống crash an toàn
 * @return {object|null} - Dữ liệu thời khóa biểu hoặc null nếu lỗi/mất kết nối
 */
function fetchSchoolTimetableData() {
  // 1. Kiểm tra cache trước để tiết kiệm băng thông và tăng tốc
  try {
    if (typeof CacheService !== "undefined") {
      var cache = CacheService.getScriptCache();
      var cachedStr = cache ? cache.get("CACHED_TKB_DATA") : null;
      if (cachedStr) {
        var parsedCache = JSON.parse(cachedStr);
        if (parsedCache && typeof parsedCache === "object") {
          return parsedCache;
        }
      }
    }
  } catch (ce) {
    if (typeof Logger !== "undefined") Logger.log("⚠️ Không thể đọc cache thời khóa biểu: " + ce);
  }
  // 2. Kiểm tra tính hợp lệ của cấu hình URL Firebase (chỉ chấp nhận HTTPS và miền Firebase hợp chuẩn)
  var fbUrl = (typeof CONFIG !== "undefined" && CONFIG && typeof CONFIG.FIREBASE_DATABASE_URL === "string") ? CONFIG.FIREBASE_DATABASE_URL.trim() : "";
  if (!fbUrl || !/^https:\/\/([a-z0-9-]+\.)*(firebaseio\.com|firebasedatabase\.app)(\/.*)?$/i.test(fbUrl)) {
    if (typeof Logger !== "undefined") {
      Logger.log("⚠️ CONFIG.FIREBASE_DATABASE_URL không hợp lệ hoặc không thuộc miền HTTPS Firebase hợp chuẩn.");
    }
    return null;
  }

  // 3. Kiểm tra môi trường thực thi (UrlFetchApp khả dụng trên Apps Script)
  if (typeof UrlFetchApp === "undefined" || !UrlFetchApp.fetch) {
    if (typeof Logger !== "undefined") Logger.log("⚠️ UrlFetchApp không khả dụng trong môi trường hiện tại.");
    return null;
  }

  // 4. Kết nối Firebase Realtime Database với cơ chế an toàn
  try {
    var options = {
      method: "get",
      muteHttpExceptions: true,
      followRedirects: true,
      validateHttpsCertificates: true
    };

    var response = UrlFetchApp.fetch(CONFIG.FIREBASE_DATABASE_URL, options);
    if (!response) {
      if (typeof Logger !== "undefined") Logger.log("⚠️ Phản hồi từ Firebase là null hoặc undefined.");
      return null;
    }

    var statusCode = response.getResponseCode ? response.getResponseCode() : 200;
    if (statusCode < 200 || statusCode >= 300) {
      if (typeof Logger !== "undefined") {
        Logger.log("⚠️ Firebase HTTP " + statusCode + " khi tải: " + CONFIG.FIREBASE_DATABASE_URL);
      }
      return null;
    }

    var text = response.getContentText ? response.getContentText() : String(response);
    if (!text || text.trim() === "" || text.trim() === "null") {
      if (typeof Logger !== "undefined") {
        Logger.log("⚠️ Dữ liệu Firebase trả về rỗng hoặc null.");
      }
      return null;
    }

    var data = JSON.parse(text);
    if (!data || typeof data !== "object") {
      if (typeof Logger !== "undefined") {
        Logger.log("⚠️ Dữ liệu Firebase không đúng định dạng JSON object.");
      }
      return null;
    }

    // Lưu cache ngắn 60 giây nếu dữ liệu hợp lệ
    try {
      var cacheToSave = typeof CacheService !== "undefined" ? CacheService.getScriptCache() : null;
      if (cacheToSave && text.length < 100000) cacheToSave.put("CACHED_TKB_DATA", text, 60);
    } catch (pe) {
      if (typeof Logger !== "undefined") {
        Logger.log("⚠️ Không thể lưu cache TKB: " + pe.toString());
      }
    }

    return data;
  } catch (e) {
    if (typeof Logger !== "undefined") {
      Logger.log("⚠️ Không thể kết nối hoặc phân tích dữ liệu Firebase TKB: " + e.toString());
    }
    return null;
  }
}

function getActiveTimetable(schoolData) {
  if (!schoolData) return { timetable: {}, weekName: "Đợt chính thức", applyDate: "" };
  var timetable = schoolData.timetable || {};
  var weekName = "Đợt hiện hành";
  var applyDate = schoolData.timetableApplyDate || "";

  if (schoolData.currentWeekId && Array.isArray(schoolData.weeklyTimetables)) {
    var wt = schoolData.weeklyTimetables.find(function(w) { return w && w.id === schoolData.currentWeekId; });
    if (wt && wt.timetable) {
      timetable = wt.timetable;
      weekName = wt.weekName || weekName;
      applyDate = wt.applyDate || applyDate;
    }
  }
  return { timetable: timetable, weekName: weekName, applyDate: applyDate };
}

function parseDayFilter(keyword) {
  if (!keyword) return null;
  var clean = removeVietnameseTones(String(keyword));
  var dayOfWeek = (new Date()).getDay();
  if (/(?:^|[^a-z0-9])(hom nay|hn|today)(?:[^a-z0-9]|$)/i.test(clean)) {
    var map = { 1: "T2", 2: "T3", 3: "T4", 4: "T5", 5: "T6", 6: "T7" };
    return map[dayOfWeek] || "T2";
  }
  if (/(?:^|[^a-z0-9])(mai|ngay mai|tomorrow)(?:[^a-z0-9]|$)/i.test(clean)) {
    var nextDay = (dayOfWeek + 1) % 7;
    var map = { 1: "T2", 2: "T3", 3: "T4", 4: "T5", 5: "T6", 6: "T7" };
    return map[nextDay] || "T2";
  }
  if (/(?:^|[^a-z0-9])(t2|thu 2|thu hai)(?:[^a-z0-9]|$)/i.test(clean)) return "T2";
  if (/(?:^|[^a-z0-9])(t3|thu 3|thu ba)(?:[^a-z0-9]|$)/i.test(clean)) return "T3";
  if (/(?:^|[^a-z0-9])(t4|thu 4|thu tu)(?:[^a-z0-9]|$)/i.test(clean)) return "T4";
  if (/(?:^|[^a-z0-9])(t5|thu 5|thu nam)(?:[^a-z0-9]|$)/i.test(clean)) return "T5";
  if (/(?:^|[^a-z0-9])(t6|thu 6|thu sau)(?:[^a-z0-9]|$)/i.test(clean)) return "T6";
  if (/(?:^|[^a-z0-9])(t7|thu 7|thu bay)(?:[^a-z0-9]|$)/i.test(clean)) return "T7";
  return null;
}

function canonicalizeVietnameseTone(str) {
  if (str == null) return "";
  var s = String(str).normalize("NFC").toLowerCase();
  s = s.replace(/úy/g, "uý").replace(/ùy/g, "uỳ").replace(/ủy/g, "uỷ").replace(/ũy/g, "uỹ").replace(/ụy/g, "uỵ");
  s = s.replace(/óa/g, "oá").replace(/òa/g, "oà").replace(/ỏa/g, "oả").replace(/õa/g, "oã").replace(/ọa/g, "oạ");
  s = s.replace(/óe/g, "oé").replace(/òe/g, "oè").replace(/ỏe/g, "oẻ").replace(/õe/g, "oẽ").replace(/ọe/g, "oẹ");
  return s;
}

function normToken(str) {
  if (str == null) return "";
  return removeVietnameseTones(String(str)).replace(/[^a-z0-9]/g, "");
}

function findMatchingClass(query, classes) {
  if (!query || !Array.isArray(classes) || classes.length === 0) return null;
  var clean = removeVietnameseTones(String(query).trim());

  var cleanTarget = clean;
  var prefixes = ["thoi khoa bieu", "lich day", "lich hoc", "xem tkb", "in tkb", "tkb", "lop"];
  var matchedPrefix = true;
  while (matchedPrefix) {
    matchedPrefix = false;
    for (var i = 0; i < prefixes.length; i++) {
      var p = prefixes[i];
      if (cleanTarget === p) {
        cleanTarget = "";
        matchedPrefix = true;
        break;
      } else if (cleanTarget.startsWith(p + " ")) {
        cleanTarget = cleanTarget.substring(p.length).trim();
        matchedPrefix = true;
        break;
      }
    }
  }

  cleanTarget = cleanTarget.replace(/(?:^|[^a-z0-9])(hom nay|hn|today|ngay mai|mai|tomorrow|thu \d|t\d|thu hai|thu ba|thu tu|thu nam|thu sau|thu bay)(?:[^a-z0-9]|$)/g, " ").trim();
  var targetToken = normToken(cleanTarget);
  var sortedClasses = classes.slice().sort(function(a, b) { return (b.name || "").length - (a.name || "").length; });

  if (targetToken) {
    for (var i = 0; i < sortedClasses.length; i++) {
      var c = sortedClasses[i];
      if (c && normToken(c.name) === targetToken) {
        return c;
      }
    }
  }

  var queryTokens = clean.split(/[^a-z0-9]+/).filter(Boolean);
  for (var i = 0; i < sortedClasses.length; i++) {
    var c = sortedClasses[i];
    if (c && c.name && queryTokens.indexOf(removeVietnameseTones(String(c.name))) !== -1) {
      return c;
    }
  }

  for (var i = 0; i < sortedClasses.length; i++) {
    var c = sortedClasses[i];
    if (c && c.name) {
      var cClean = removeVietnameseTones(String(c.name)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
      var regex = new RegExp("(?:^|[^a-z0-9])" + cClean + "(?:[^a-z0-9]|$)", "i");
      if (regex.test(clean)) {
        return c;
      }
    }
  }

  return null;
}

function findMatchingTeacher(rawQuery, teachers) {
  if (!rawQuery || !Array.isArray(teachers) || teachers.length === 0) return null;
  var text = String(rawQuery).trim();
  var clean = removeVietnameseTones(text);

  var cleanTarget = clean;
  var prefixes = ["thoi khoa bieu", "lich day", "lich hoc", "xem tkb", "in tkb", "tkb", "thay", "co", "gv"];
  var matchedPrefix = true;
  while (matchedPrefix) {
    matchedPrefix = false;
    for (var i = 0; i < prefixes.length; i++) {
      var p = prefixes[i];
      if (cleanTarget === p) {
        cleanTarget = "";
        matchedPrefix = true;
        break;
      } else if (cleanTarget.startsWith(p + " ")) {
        cleanTarget = cleanTarget.substring(p.length).trim();
        matchedPrefix = true;
        break;
      }
    }
  }

  cleanTarget = cleanTarget.replace(/(?:^|[^a-z0-9])(hom nay|hn|today|ngay mai|mai|tomorrow|thu \d|t\d|thu hai|thu ba|thu tu|thu nam|thu sau|thu bay)(?:[^a-z0-9]|$)/g, " ").trim();
  var targetCanon = canonicalizeVietnameseTone(cleanTarget).replace(/[^a-z0-9à-ỹ]/g, "");
  var targetToken = normToken(cleanTarget);

  // 1. Khớp chính xác shortName
  for (var i = 0; i < teachers.length; i++) {
    var t = teachers[i];
    if (t && t.shortName) {
      var tCanon = canonicalizeVietnameseTone(t.shortName).replace(/[^a-z0-9à-ỹ]/g, "");
      if (tCanon && tCanon === targetCanon) return t;
    }
  }

  // 2. Khớp chính xác fullName
  for (var i = 0; i < teachers.length; i++) {
    var t = teachers[i];
    if (t && t.fullName) {
      var tCanon = canonicalizeVietnameseTone(t.fullName).replace(/[^a-z0-9à-ỹ]/g, "");
      if (tCanon && tCanon === targetCanon) return t;
    }
  }

  // 3. Khớp token
  if (targetToken) {
    var shortMatches = teachers.filter(function(t) { return t && t.shortName && normToken(t.shortName) === targetToken; });
    if (shortMatches.length === 1) return shortMatches[0];
    if (shortMatches.length > 1) {
      var exactCanon = shortMatches.find(function(t) { return canonicalizeVietnameseTone(t.shortName).replace(/[^a-z0-9à-ỹ]/g, "") === targetCanon; });
      if (exactCanon) return exactCanon;
      return shortMatches[0];
    }

    var fullMatches = teachers.filter(function(t) { return t && t.fullName && normToken(t.fullName) === targetToken; });
    if (fullMatches.length === 1) return fullMatches[0];
    if (fullMatches.length > 1) {
      var exactCanon = fullMatches.find(function(t) { return canonicalizeVietnameseTone(t.fullName).replace(/[^a-z0-9à-ỹ]/g, "") === targetCanon; });
      if (exactCanon) return exactCanon;
      return fullMatches[0];
    }
  }

  // 4. Khớp shortName với ranh giới từ
  var sortedByShort = teachers.slice().sort(function(a, b) { return ((b && b.shortName) || "").length - ((a && a.shortName) || "").length; });
  for (var i = 0; i < sortedByShort.length; i++) {
    var t = sortedByShort[i];
    if (!t || !t.shortName) continue;
    var sClean = removeVietnameseTones(String(t.shortName)).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    var sPattern = sClean.replace(/\\\./g, "[._\\s]?");
    var regex = new RegExp("(?:^|[^a-z0-9])" + sPattern + "(?:[^a-z0-9]|$)", "i");
    if (regex.test(clean)) return t;
  }

  // 5. Khớp fullName với ranh giới từ
  var sortedByFull = teachers.slice().sort(function(a, b) { return ((b && b.fullName) || "").length - ((a && a.fullName) || "").length; });
  for (var i = 0; i < sortedByFull.length; i++) {
    var t = sortedByFull[i];
    if (!t || !t.fullName) continue;
    var fClean = removeVietnameseTones(String(t.fullName));
    if (fClean.length >= 4) {
      var regex = new RegExp("(?:^|[^a-z0-9])" + fClean.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+") + "(?:[^a-z0-9]|$)", "i");
      if (regex.test(clean)) return t;
    }
  }

  return null;
}

function getHomeroomTeacher(classObj, timetable, assignments, teachers) {
  if (!classObj) return null;
  if (typeof classObj.gvcn === "string" && classObj.gvcn.trim()) {
    var rawGv = classObj.gvcn.trim();
    var t = Array.isArray(teachers) ? teachers.find(function(x) { return x && (x.shortName === rawGv || x.fullName === rawGv); }) : null;
    return t ? (t.fullName + " (" + t.shortName + ")") : rawGv;
  }

  var className = classObj.name;
  var gvShort = "";
  var clsSchedule = (timetable && timetable[className]) ? timetable[className] : {};
  var days = ["T2", "T3", "T4", "T5", "T6", "T7"];

  for (var d = 0; d < days.length; d++) {
    var daySlots = clsSchedule[days[d]] || {};
    for (var p = 1; p <= 5; p++) {
      var slot = daySlots[p];
      if (slot && typeof slot.subject === "string" && typeof slot.teacher === "string" && slot.subject.trim()) {
        var sub = slot.subject.toLowerCase();
        if (sub.includes("shl") || sub.includes("sinh hoat") || sub.includes("hdtn")) {
          gvShort = slot.teacher;
          break;
        }
      }
    }
    if (gvShort) break;
  }

  if (!gvShort) return null;
  var tObj = Array.isArray(teachers) ? teachers.find(function(x) { return x && x.shortName === gvShort; }) : null;
  return tObj ? (tObj.fullName + " (" + tObj.shortName + ")") : gvShort;
}

function sendZaloBotReply(chatId, text) {
  var botToken =
    typeof CONFIG !== "undefined" &&
    CONFIG &&
    typeof CONFIG.ZALO_BOT_TOKEN === "string"
      ? CONFIG.ZALO_BOT_TOKEN.trim()
      : "";
  if (!botToken || !chatId) return { success: false, reason: "MISSING_PARAMS" };
  var apiUrl = "https://bot-api.zaloplatforms.com/bot" + botToken + "/sendMessage";
  var payload = {
    chat_id: String(chatId),
    text: text
  };

  try {
    var response = UrlFetchApp.fetch(apiUrl, {
      method: "post",
      contentType: "application/json",
      payload: JSON.stringify(payload),
      muteHttpExceptions: true
    });

    var statusCode = response ? (typeof response.getResponseCode === "function" ? response.getResponseCode() : 200) : 0;
    var responseText = response ? (typeof response.getContentText === "function" ? response.getContentText() : "") : "";

    if (statusCode !== 200) {
      Logger.log("⚠️ Lỗi gửi tin Zalo Bot (HTTP " + statusCode + "): " + responseText);
      return { success: false, statusCode: statusCode, error: responseText };
    }

    return { success: true, statusCode: 200, result: responseText };
  } catch (e) {
    Logger.log("❌ Ngoại lệ mạng khi gọi Zalo Bot API: " + e.toString());
    return { success: false, error: e.toString() };
  }
}

function getChatIdByPhone(phoneNumber) {
  var ss = getDatabaseSpreadsheet();
  if (!ss) return null;
  var sheet = ss.getSheetByName(CONFIG.SHEET_USERS);
  if (!sheet) return null;

  var targetNorm = normalizePhone(phoneNumber);
  if (!targetNorm) return null;
  var data = sheet.getDataRange().getValues();
  for (var i = 1; i < data.length; i++) {
    if (!data[i] || data[i][2] == null) continue;
    var rowPhone = normalizePhone(String(data[i][2]));
    if (rowPhone === targetNorm) {
      var chatId = String(data[i][5] || "").trim();
      return chatId ? chatId : null;
    }
  }
  return null;
}

function normalizePhone(p) {
  if (!p) return "";
  var clean = String(p).replace(/[^0-9]/g, "");
  if (clean.startsWith("840") && clean.length >= 11) {
    clean = clean.slice(2);
  } else if (clean.startsWith("84") && clean.length >= 10) {
    clean = "0" + clean.slice(2);
  }
  if (clean.length === 9 && !clean.startsWith("0")) {
    clean = "0" + clean; // Di động rụng số 0: 9 chữ số -> 10 chữ số chuẩn
  } else if (clean.length === 10 && clean.startsWith("2")) {
    clean = "0" + clean; // Cố định QCVN 11 chữ số (đầu 2) rụng số 0 -> 11 chữ số chuẩn
  }
  return clean;
}

function removeVietnameseTones(str) {
  if (!str) return "";
  str = str.replace(/à|á|ạ|ả|ã|â|ầ|ấ|ậ|ẩ|ẫ|ă|ằ|ắ|ặ|ẳ|ẵ/g, "a");
  str = str.replace(/è|é|ẹ|ẻ|ẽ|ê|ề|ế|ệ|ể|ễ/g, "e");
  str = str.replace(/ì|í|ị|ỉ|ĩ/g, "i");
  str = str.replace(/ò|ó|ọ|ỏ|õ|ô|ồ|ố|ộ|ổ|ỗ|ơ|ờ|ớ|ợ|ở|ỡ/g, "o");
  str = str.replace(/ù|ú|ụ|ủ|ũ|ư|ừ|ứ|ự|ử|ữ/g, "u");
  str = str.replace(/ỳ|ý|ỵ|ỷ|ỹ/g, "y");
  str = str.replace(/đ/g, "d");
  str = str.replace(/À|Á|Ạ|Ả|Ã|Â|Ầ|Ấ|Ậ|Ẩ|Ẫ|Ă|Ằ|Ắ|Ặ|Ẳ|Ẵ/g, "A");
  str = str.replace(/È|É|Ẹ|Ẻ|Ẽ|Ê|Ề|Ế|Ệ|Ể|Ễ/g, "E");
  str = str.replace(/Ì|Í|Ị|Ỉ|Ĩ/g, "I");
  str = str.replace(/Ò|Ó|Ọ|Ỏ|Õ|Ô|Ồ|Ố|Ộ|Ổ|Ỗ|Ơ|Ờ|Ớ|Ợ|Ở|Ỡ/g, "O");
  str = str.replace(/Ù|Ú|Ụ|Ủ|Ũ|Ư|Ừ|Ứ|Ự|Ử|Ữ/g, "U");
  str = str.replace(/Ỳ|Ý|Ỵ|Ỷ|Ỹ/g, "Y");
  str = str.replace(/Đ/g, "D");
  return str.toLowerCase().trim();
}

function getOrCreateFolderHierarchy(pathStr) {
  var currentFolder = DriveApp.getRootFolder();
  if (typeof pathStr !== "string" || !pathStr.trim()) return currentFolder;
  var parts = pathStr.split("/").map(function(s) { return s.trim(); }).filter(Boolean);
  for (var i = 0; i < parts.length; i++) {
    var name = parts[i];
    var folders = currentFolder.getFoldersByName(name);
    if (folders.hasNext()) {
      currentFolder = folders.next();
    } else {
      currentFolder = currentFolder.createFolder(name);
    }
  }
  return currentFolder;
}

// Hỗ trợ xuất Module để chạy kiểm thử tự động trên môi trường Node.js
if (typeof module !== "undefined" && module.exports) {
  module.exports = {
    CONFIG: CONFIG,
    normalizePhone: normalizePhone,
    removeVietnameseTones: removeVietnameseTones,
    canonicalizeVietnameseTone: canonicalizeVietnameseTone,
    parseDayFilter: parseDayFilter,
    findMatchingClass: findMatchingClass,
    findMatchingTeacher: findMatchingTeacher,
    getHomeroomTeacher: getHomeroomTeacher,
    getActiveTimetable: getActiveTimetable,
    formatPeriodTime: formatPeriodTime,
    formatTeacherTimetableResponse: formatTeacherTimetableResponse,
    formatClassTimetableResponse: formatClassTimetableResponse,
    generateMorningTeacherMessage: generateMorningTeacherMessage,
    generateTomorrowTeacherMessage: generateTomorrowTeacherMessage,
    findNextTeachingSession: findNextTeachingSession,
    testSendTomorrowSchedule: testSendTomorrowSchedule,
    getUnifiedWelcomeGuideText: getUnifiedWelcomeGuideText,
    handleNaturalTimetableQuery: handleNaturalTimetableQuery,
    handleSubstitutionQuery: handleSubstitutionQuery,
    handleFindFreeTeacherQuery: handleFindFreeTeacherQuery,
    handleNewTimetableAnnouncement: handleNewTimetableAnnouncement,
    processUnifiedZaloMessage: processUnifiedZaloMessage,
    handleEduSignNotification: handleEduSignNotification,
    fetchReportsFromSheet: fetchReportsFromSheet,
    deleteReportFromSheet: deleteReportFromSheet,
    setupDailyMorningTrigger: setupDailyMorningTrigger,
    removeOldTriggers: removeOldTriggers,
    setupMorningBriefGroupTrigger: setupMorningBriefGroupTrigger,
    sendDailyMorningPersonalSchedule: sendDailyMorningPersonalSchedule,
    sendMorningBriefGroup: sendMorningBriefGroup,
    generateMorningSchoolBriefMessage: generateMorningSchoolBriefMessage,
    fetchSchoolTimetableData: fetchSchoolTimetableData,
    getSessionSpan: getSessionSpan,
    handleSyncTeacher: handleSyncTeacher,
    handleSyncTeachersBatch: handleSyncTeachersBatch,
    handleSecurePhoneMapping: handleSecurePhoneMapping,
    initSheetsIfMissing: initSheetsIfMissing
  };
}

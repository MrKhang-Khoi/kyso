const googleDriveService = require('./googleDriveService');
const dataStore = require('./dataStore');

/**
 * Service gửi thông báo Zalo 1-1 thông qua Google Apps Script Webhook
 * Chuẩn Kịch bản A: Mapping Số Điện Thoại -> Zalo Chat ID (0 đồng, không lo khóa nick)
 * Tiêu chuẩn bảo mật webhook secret token tham chiếu: UnifiedZaloBotTHCSCVA2026Secret
 */

function getSafeDriveConfig() {
  try {
    if (googleDriveService && typeof googleDriveService.getDriveConfig === 'function') {
      return googleDriveService.getDriveConfig();
    }
  } catch (err) {
    console.warn('[ZaloNotify] Lỗi đọc cấu hình từ googleDriveService:', err.message);
  }
  return null;
}

function getWebhookUrl(cfg) {
  const raw = cfg && typeof cfg.gasWebhookUrl === 'string'
    ? cfg.gasWebhookUrl.trim()
    : '';

  if (!raw) return '';

  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' ? parsed.toString() : '';
  } catch {
    return '';
  }
}

function getWebhookSecret(cfg) {
  if (process.env.ZALO_WEBHOOK_SECRET && typeof process.env.ZALO_WEBHOOK_SECRET === 'string' && process.env.ZALO_WEBHOOK_SECRET.trim()) {
    return process.env.ZALO_WEBHOOK_SECRET.trim();
  }
  if (cfg && typeof cfg.gasWebhookSecret === 'string' && cfg.gasWebhookSecret.trim()) {
    return cfg.gasWebhookSecret.trim();
  }
  return '';
}

/**
 * Gửi yêu cầu HTTP POST tới Google Apps Script Webhook
 */
async function sendWebhookPost(payloadObj) {
  if (!payloadObj || typeof payloadObj !== 'object' || Array.isArray(payloadObj)) {
    return { success: false, reason: 'INVALID_PAYLOAD' };
  }

  let cfg;
  try {
    cfg = getSafeDriveConfig();
  } catch (cfgErr) {
    console.warn('[ZaloNotify] Lỗi lấy cấu hình Webhook:', cfgErr.message);
    return { success: false, reason: 'CONFIG_ERROR', error: cfgErr.message };
  }

  const url = getWebhookUrl(cfg);
  if (!url) {
    console.log('[ZaloNotify] Chưa cấu hình gasWebhookUrl hợp lệ (yêu cầu https://) trong drive_config.json, bỏ qua gửi Zalo.');
    return { success: false, reason: 'NO_WEBHOOK_URL' };
  }

  const secretToken = getWebhookSecret(cfg);
  if (!secretToken) {
    console.warn('[ZaloNotify] Chưa cấu hình ZALO_WEBHOOK_SECRET trong môi trường hoặc gasWebhookSecret trong drive_config.json, từ chối gửi để bảo đảm an toàn.');
    return { success: false, reason: 'MISSING_WEBHOOK_SECRET' };
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout

  const payloadWithSecret = {
    ...payloadObj,
    secret_token: secretToken
  };

  let res;
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: JSON.stringify(payloadWithSecret),
      redirect: 'follow', // Chấp nhận redirect 302 từ Google Apps Script
      signal: controller.signal
    });
  } catch (err) {
    console.warn('[ZaloNotify] Lỗi gửi thông báo sang Google Apps Script:', err.message);
    return {
      success: false,
      reason: err.name === 'AbortError' ? 'TIMEOUT' : 'NETWORK_ERROR',
      error: err.message
    };
  } finally {
    clearTimeout(timeoutId);
  }

  let text = '';
  try {
    text = await res.text();
  } catch (readErr) {
    return {
      success: false,
      status: res.status,
      reason: 'READ_BODY_FAILED',
      error: readErr.message
    };
  }

  let data;
  try {
    data = JSON.parse(text);
  } catch (parseErr) {
    data = { raw: text, parseError: parseErr.message };
  }

  if (!res.ok) {
    return {
      success: false,
      status: res.status,
      statusText: res.statusText,
      error: (data && (data.message || data.error)) || `HTTP_${res.status}`,
      details: data
    };
  }

  if (data && typeof data === 'object') {
    return {
      success: data.success !== false,
      ...data
    };
  }

  return { success: true, raw: text };
}

function maskPhone(phone) {
  if (!phone || typeof phone !== 'string') return 'N/A';
  const trimmed = phone.trim();
  if (trimmed.length <= 4) return '***';
  return '***' + trimmed.slice(-4);
}

/**
 * Tìm số điện thoại của người dùng theo ID hoặc Username
 */
function findUserPhone(userIdOrUsername) {
  if (!userIdOrUsername || typeof userIdOrUsername !== 'string') return '';
  const trimmed = userIdOrUsername.trim();
  if (!trimmed) return '';
  try {
    const users = dataStore.getUsers();
    if (!Array.isArray(users)) return '';
    const u = users.find(x => x && (x.id === trimmed || x.username === trimmed));
    return u && typeof u.phone === 'string' ? u.phone.trim() : '';
  } catch (err) {
    console.warn(
      '[ZaloNotify] Lỗi tìm số điện thoại người dùng:',
      err instanceof Error ? err.message : String(err)
    );
    return '';
  }
}

/**
 * 1. Bắn tin Zalo khi hồ sơ BỊ TRẢ VỀ (REJECTED)
 */
async function notifyDocumentRejected(doc, approverUser, reason) {
  if (!doc || typeof doc !== 'object') return { success: false, reason: 'INVALID_DOC' };
  const authorPhone = findUserPhone(doc.creatorId || doc.creatorUsername || doc.authorId || doc.authorUsername);
  const approverName = (approverUser && (approverUser.fullName || approverUser.name)) || doc.returnedByName || 'Ban Giám hiệu';

  const rejectionReason =
    typeof reason === 'string' && reason.trim()
      ? reason.trim()
      : typeof doc.returnReason === 'string' && doc.returnReason.trim()
        ? doc.returnReason.trim()
        : 'Cần chỉnh sửa nội dung';

  console.log(`[ZaloNotify] Đang gửi thông báo TRẢ VỀ tới SĐT tác giả: ${maskPhone(authorPhone)}`);

  return await sendWebhookPost({
    action: 'NOTIFY_SIGN_EVENT',
    eventType: 'REJECTED',
    docId: doc.id ? String(doc.id) : '',
    docTitle: doc.title ? String(doc.title) : '',
    authorPhone: authorPhone,
    approverName: String(approverName),
    reason: rejectionReason,
    senderName: String(approverName)
  });
}

/**
 * 2. Bắn tin Zalo khi có HỒ SƠ MỚI CẦN KÝ DUYỆT (SUBMITTED / FORWARDED)
 * Gửi tin nhắn cho Người duyệt đồng thời gửi xác nhận tức thì cho Tác giả
 */
async function notifyDocumentSubmitted(doc, senderUser, targetUserId) {
  if (!doc || typeof doc !== 'object') return { success: false, reason: 'INVALID_DOC' };
  const authorPhone = findUserPhone(doc.creatorId || doc.creatorUsername || doc.authorId || doc.authorUsername || (senderUser && (senderUser.id || senderUser.username)));
  const recipientPhone = typeof targetUserId === 'string' && targetUserId.trim() ? findUserPhone(targetUserId.trim()) : '';
  const senderName = (senderUser && (senderUser.fullName || senderUser.name)) || doc.creatorName || doc.author || 'Giáo viên';

  console.log(`[ZaloNotify] Đang gửi thông báo TRÌNH KÝ: Tác giả SĐT=${maskPhone(authorPhone)}, Người duyệt SĐT=${maskPhone(recipientPhone)}`);

  return await sendWebhookPost({
    action: 'NOTIFY_SIGN_EVENT',
    eventType: 'SUBMITTED',
    docId: doc.id ? String(doc.id) : '',
    docTitle: doc.title ? String(doc.title) : '',
    authorPhone: authorPhone,
    recipientPhone: recipientPhone,
    senderName: String(senderName)
  });
}

/**
 * 2.1 Bắn tin Zalo khi GIÁO VIÊN TỰ KÝ GIÁO ÁN / HỒ SƠ CÁ NHÂN HOÀN TẤT
 */
async function notifyDocumentPersonalSigned(doc, user) {
  if (!doc || typeof doc !== 'object') return { success: false, reason: 'INVALID_DOC' };
  const authorPhone = findUserPhone(doc.creatorId || doc.creatorUsername || doc.authorId || doc.authorUsername || (user && (user.id || user.username)));
  const senderName = (user && (user.fullName || user.name)) || doc.creatorName || doc.author || 'Giáo viên';

  console.log(`[ZaloNotify] Đang gửi thông báo KÝ GIÁO ÁN CÁ NHÂN tới SĐT tác giả: ${maskPhone(authorPhone)}`);

  return await sendWebhookPost({
    action: 'NOTIFY_SIGN_EVENT',
    eventType: 'PERSONAL_SIGNED',
    docId: doc.id ? String(doc.id) : '',
    docTitle: doc.title ? String(doc.title) : '',
    authorPhone: authorPhone,
    senderName: String(senderName)
  });
}

/**
 * 3. Bắn tin Zalo khi BÁO CÁO ĐÃ ĐƯỢC DUYỆT HOÀN THÀNH (COMPLETED)
 * - Nếu hasSchoolSeal: true -> Thông báo đã đóng mộc đỏ nhà trường hoàn tất.
 * - Nếu hasSchoolSeal: false -> Thông báo báo cáo nội bộ đã được duyệt (không có dòng con dấu).
 */
async function notifyDocumentCompleted(doc, approverUser, viewUrl = '') {
  if (!doc || typeof doc !== 'object') return { success: false, reason: 'INVALID_DOC' };
  const authorPhone = findUserPhone(doc.creatorId || doc.creatorUsername || doc.authorId || doc.authorUsername);
  const isRealSchoolSeal = Boolean(doc.hasSchoolSeal === true || (approverUser && (approverUser.role === 'CON_DAU_NHA_TRUONG' || approverUser.signerRole === 'seal')));
  const approverName = isRealSchoolSeal 
    ? 'TRƯỜNG THCS CHU VĂN AN' 
    : ((approverUser && (approverUser.fullName || approverUser.name)) || doc.finalSigner || 'Ban Giám hiệu');
  const requiresSeal = Boolean(doc.requiresSeal === true || doc.reportCategory === 'SCHOOL');
  const reportCategory = doc.reportCategory || (requiresSeal ? 'SCHOOL' : 'INTERNAL');

  console.log(`[ZaloNotify] Đang gửi thông báo HOÀN TẤT KÝ DUYỆT (hasSchoolSeal=${isRealSchoolSeal}) tới SĐT tác giả: ${maskPhone(authorPhone)}`);

  return await sendWebhookPost({
    action: 'NOTIFY_SIGN_EVENT',
    eventType: 'COMPLETED',
    docId: doc.id ? String(doc.id) : '',
    docTitle: doc.title ? String(doc.title) : '',
    authorPhone: authorPhone,
    approverName: String(approverName),
    viewUrl: typeof viewUrl === 'string' ? viewUrl : '',
    hasSchoolSeal: isRealSchoolSeal,
    isSchoolSeal: isRealSchoolSeal,
    requiresSeal: requiresSeal,
    reportCategory: String(reportCategory)
  });
}

/**
 * 3.1 Bắn tin Zalo khi BAN GIÁM HIỆU ĐÃ KÝ DUYỆT BÁO CÁO CẤP TRƯỜNG (BGH_APPROVED / PENDING_SEAL)
 * - Thông báo Ban Giám hiệu đã phê duyệt, đang chờ Văn thư/BGH đóng dấu mộc đỏ bằng USB Token
 */
async function notifyDocumentBghApproved(doc, approverUser, viewUrl = '') {
  if (!doc || typeof doc !== 'object') return { success: false, reason: 'INVALID_DOC' };
  const authorPhone = findUserPhone(doc.creatorId || doc.creatorUsername || doc.authorId || doc.authorUsername);
  const approverName = (approverUser && (approverUser.fullName || approverUser.name)) || doc.bghSigner || 'Ban Giám hiệu';

  console.log(`[ZaloNotify] Đang gửi thông báo BGH PHÊ DUYỆT (CHỜ ĐÓNG DẤU) tới SĐT tác giả: ${maskPhone(authorPhone)}`);

  const finalViewUrl = (typeof viewUrl === 'string' && viewUrl.trim())
    ? viewUrl.trim()
    : (doc.driveInfo && typeof doc.driveInfo.viewUrl === 'string' ? doc.driveInfo.viewUrl.trim() : '');

  return await sendWebhookPost({
    action: 'NOTIFY_SIGN_EVENT',
    eventType: 'BGH_APPROVED',
    docId: doc.id ? String(doc.id) : '',
    docTitle: doc.title ? String(doc.title) : '',
    authorPhone: authorPhone,
    approverName: String(approverName),
    viewUrl: finalViewUrl,
    hasSchoolSeal: false,
    isSchoolSeal: false,
    requiresSeal: true,
    reportCategory: 'SCHOOL'
  });
}

/**
 * 4. Bắn tin Zalo khi hồ sơ ĐƯỢC CHUYỂN TIẾP CHO NGƯỜI KÝ TIẾP THEO (FORWARDED) - DEFECT-ZALO-01
 */
async function notifyDocumentForwarded(doc, senderUser, targetUserId) {
  if (!doc || typeof doc !== 'object') return { success: false, reason: 'INVALID_DOC' };
  const recipientPhone = typeof targetUserId === 'string' && targetUserId.trim() ? findUserPhone(targetUserId.trim()) : '';
  const senderName = (senderUser && (senderUser.fullName || senderUser.name)) || 'Người ký trước';

  console.log(`[ZaloNotify] Đang gửi thông báo CHUYỂN TIẾP (FORWARDED) tới SĐT: ${maskPhone(recipientPhone)}`);

  return await sendWebhookPost({
    action: 'NOTIFY_SIGN_EVENT',
    eventType: 'FORWARDED',
    docId: doc.id ? String(doc.id) : '',
    docTitle: doc.title ? String(doc.title) : '',
    recipientPhone: recipientPhone,
    senderName: String(senderName),
    hasSchoolSeal: false,
    requiresSeal: Boolean(doc.requiresSeal || doc.reportCategory === 'SCHOOL'),
    reportCategory: String(doc.reportCategory || (doc.requiresSeal ? 'SCHOOL' : 'INTERNAL'))
  });
}

module.exports = {
  sendWebhookPost,
  sendZaloNotificationViaGAS: sendWebhookPost,
  findUserPhone,
  notifyDocumentRejected,
  notifyDocumentSubmitted,
  notifyDocumentForwarded,
  notifyDocumentPersonalSigned,
  notifyDocumentCompleted,
  notifyDocumentBghApproved
};

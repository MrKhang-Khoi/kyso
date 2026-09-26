/**
 * ====================================================================================================
 * 🚀 SCRIPT ĐỒNG BỘ DỮ LIỆU LÊN GOOGLE FIREBASE REALTIME DATABASE (EduSign VGCA - THCS Chu Văn An)
 * ====================================================================================================
 * Mục đích:
 * 1. Đọc và kiểm tra an toàn dữ liệu từ data/users.json, data/documents.json, data/bgh_signing_config.json
 * 2. Làm sạch các trường nhị phân Base64 nặng và dữ liệu nhạy cảm trước khi đồng bộ
 * 3. Hỗ trợ xác thực qua biến môi trường FIREBASE_AUTH_TOKEN / FIREBASE_DATABASE_SECRET
 * 4. Kiểm soát thời gian chờ (timeout) qua AbortController trên từng request mạng
 * ====================================================================================================
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const RTDB_URL = process.env.FIREBASE_RTDB_URL || 'https://edusign-school-default-rtdb.asia-southeast1.firebasedatabase.app';
const DOCS_FILE = path.join(ROOT_DIR, 'data', 'documents.json');
const USERS_FILE = path.join(ROOT_DIR, 'data', 'users.json');
const BGH_CONFIG_FILE = path.join(ROOT_DIR, 'data', 'bgh_signing_config.json');

/**
 * Xây dựng URL đích kèm tham số xác thực nếu có cấu hình trong môi trường
 */
function buildAuthenticatedUrl(endpointPath) {
  if (typeof endpointPath !== 'string' || !endpointPath.trim()) {
    throw new TypeError('endpointPath must be a non-empty string');
  }
  const cleanBase = RTDB_URL.replace(/\/+$/, '');
  const cleanPath = endpointPath.startsWith('/') ? endpointPath : `/${endpointPath}`;
  const authToken = process.env.FIREBASE_AUTH_TOKEN || process.env.FIREBASE_DATABASE_SECRET;
  if (authToken && typeof authToken === 'string' && authToken.trim()) {
    const separator = cleanPath.includes('?') ? '&' : '?';
    return `${cleanBase}${cleanPath}${separator}auth=${encodeURIComponent(authToken.trim())}`;
  }
  return `${cleanBase}${cleanPath}`;
}

/**
 * Helper thực hiện request HTTP với giới hạn thời gian qua AbortController
 */
async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  if (typeof url !== 'string' || !url.trim()) {
    throw new TypeError('url must be a non-empty string');
  }
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Tiêu thụ hoặc hủy response stream để ngăn chặn rò rỉ socket connection pool trong Node.js Undici
 */
async function drainResponseBody(res) {
  if (!res) return;
  try {
    if (res.body && typeof res.body.cancel === 'function') {
      await res.body.cancel();
    } else if (typeof res.arrayBuffer === 'function') {
      await res.arrayBuffer();
    }
  } catch (drainErr) {
    // Không để lỗi giải phóng body ảnh hưởng đến luồng chính
  }
}

/**
 * Đọc và parse an toàn tệp JSON, tránh crash tiến trình khi gặp file hỏng hoặc sai định dạng
 */
function safeReadJson(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return null;
    }
    const rawContent = fs.readFileSync(filePath, 'utf8');
    if (!rawContent || !rawContent.trim()) {
      return null;
    }
    return JSON.parse(rawContent);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.warn(`⚠️ [JSON Parser] Không thể đọc hoặc phân tích cú pháp tệp [${filePath}]:`, message);
    return null;
  }
}

async function syncAll() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🚀 ĐỒNG BỘ DỮ LIỆU LÊN GOOGLE FIREBASE REALTIME DATABASE');
  console.log('URL Gốc:', RTDB_URL);
  console.log('Xác thực:', (process.env.FIREBASE_AUTH_TOKEN || process.env.FIREBASE_DATABASE_SECRET) ? 'Đã bật qua Auth Token' : 'Mặc định (Rules-based)');
  console.log('═══════════════════════════════════════════════════════════════\n');

  const results = {
    usersSynced: false,
    docsSynced: false,
    bghSynced: false,
    usersStatus: 'SKIPPED',
    docsStatus: 'SKIPPED',
    bghStatus: 'SKIPPED',
    syncedUsersCount: 0,
    syncedDocsCount: 0
  };

  // 1. Đồng bộ người dùng
  try {
    const rawUsers = safeReadJson(USERS_FILE);
    if (rawUsers !== null) {
      if (!Array.isArray(rawUsers)) {
        results.usersStatus = 'FAILED';
        console.warn('⚠️ [1/3] data/users.json không phải là một mảng hợp lệ, bỏ qua đồng bộ người dùng.');
      } else {
        const SENSITIVE_USER_FIELDS = [
          'password', 'passwordHash', 'salt', 'token', 'accessToken',
          'refreshToken', 'secret', 'privateKey', 'authSecret', 'sessionToken'
        ];

        const sanitizedUsers = rawUsers
          .filter(u => u && typeof u === 'object' && !Array.isArray(u))
          .map(u => {
            const copy = { ...u };
            for (const field of SENSITIVE_USER_FIELDS) {
              delete copy[field];
            }
            return copy;
          });

        console.log(`📤 [1/3] Đang tải lên ${sanitizedUsers.length} tài khoản người dùng...`);
        const targetUrl = buildAuthenticatedUrl('/users.json');
        const res = await fetchWithTimeout(targetUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(sanitizedUsers)
        }, 8000);

        try {
          if (res.ok) {
            results.usersSynced = true;
            results.usersStatus = 'SUCCESS';
            results.syncedUsersCount = sanitizedUsers.length;
            console.log(`✅ [1/3] Đã đồng bộ thành công ${sanitizedUsers.length} tài khoản người dùng!`);
          } else {
            results.usersStatus = 'FAILED';
            console.warn(`⚠️ [1/3] Lỗi phản hồi HTTP từ Firebase khi đồng bộ users: ${res.status} ${res.statusText}`);
          }
        } finally {
          await drainResponseBody(res);
        }
      }
    } else {
      results.usersStatus = 'SKIPPED';
      console.log('ℹ️ [1/3] Tệp data/users.json không tồn tại hoặc rỗng, bỏ qua.');
    }
  } catch (err) {
    results.usersStatus = 'FAILED';
    const message = err instanceof Error ? err.message : String(err);
    console.error('❌ [1/3] Ngoại lệ khi đồng bộ người dùng lên Firebase:', message);
  }

  // 2. Đồng bộ hồ sơ giáo án (đã làm sạch Base64 và payload nặng)
  try {
    const rawDocs = safeReadJson(DOCS_FILE);
    if (rawDocs !== null) {
      if (!Array.isArray(rawDocs)) {
        results.docsStatus = 'FAILED';
        console.warn('⚠️ [2/3] data/documents.json không phải là một mảng hợp lệ, bỏ qua đồng bộ hồ sơ.');
      } else {
        const cleanDocs = rawDocs
          .filter(d => d && typeof d === 'object' && !Array.isArray(d))
          .map(d => {
            const clean = { ...d };
            delete clean.fileBase64;
            delete clean.signedPdfBase64;
            delete clean.rawContent;
            return clean;
          });

        console.log(`📤 [2/3] Đang tải lên ${cleanDocs.length} hồ sơ giáo án (đã làm sạch Base64)...`);
        const targetUrl = buildAuthenticatedUrl('/documents.json');
        const res = await fetchWithTimeout(targetUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(cleanDocs)
        }, 8000);

        try {
          if (res.ok) {
            results.docsSynced = true;
            results.docsStatus = 'SUCCESS';
            results.syncedDocsCount = cleanDocs.length;
            console.log(`✅ [2/3] Đã đồng bộ thành công ${cleanDocs.length} hồ sơ giáo án lên Firebase!`);
          } else {
            results.docsStatus = 'FAILED';
            console.warn(`⚠️ [2/3] Lỗi phản hồi HTTP từ Firebase khi đồng bộ documents: ${res.status} ${res.statusText}`);
          }
        } finally {
          await drainResponseBody(res);
        }
      }
    } else {
      results.docsStatus = 'SKIPPED';
      console.log('ℹ️ [2/3] Tệp data/documents.json không tồn tại hoặc rỗng, bỏ qua.');
    }
  } catch (err) {
    results.docsStatus = 'FAILED';
    const message = err instanceof Error ? err.message : String(err);
    console.error('❌ [2/3] Ngoại lệ khi đồng bộ hồ sơ giáo án lên Firebase:', message);
  }

  // 3. Đồng bộ cấu hình chứng thư số USB Token Ban Giám hiệu
  try {
    const rawBghCfg = safeReadJson(BGH_CONFIG_FILE);
    if (rawBghCfg !== null) {
      if (typeof rawBghCfg !== 'object' || Array.isArray(rawBghCfg)) {
        results.bghStatus = 'FAILED';
        console.warn('⚠️ [3/3] data/bgh_signing_config.json không phải là đối tượng hợp lệ, bỏ qua.');
      } else {
        const safeCfg = { ...rawBghCfg };
        // Triệt tiêu các trường khóa bí mật hoặc PIN nếu có
        delete safeCfg.pin;
        delete safeCfg.privateKey;

        console.log(`📤 [3/3] Đang tải lên cấu hình USB Token Ban Giám hiệu...`);
        const targetUrl = buildAuthenticatedUrl('/configs/bgh_signing_config.json');
        const res = await fetchWithTimeout(targetUrl, {
          method: 'PUT',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(safeCfg)
        }, 8000);

        try {
          if (res.ok) {
            results.bghSynced = true;
            results.bghStatus = 'SUCCESS';
            console.log(`✅ [3/3] Đã đồng bộ thành công cấu hình BGH lên Firebase!`);
          } else {
            results.bghStatus = 'FAILED';
            console.warn(`⚠️ [3/3] Lỗi phản hồi HTTP từ Firebase khi đồng bộ cấu hình BGH: ${res.status} ${res.statusText}`);
          }
        } finally {
          await drainResponseBody(res);
        }
      }
    } else {
      results.bghStatus = 'SKIPPED';
      console.log('ℹ️ [3/3] Tệp data/bgh_signing_config.json không tồn tại hoặc rỗng, bỏ qua.');
    }
  } catch (err) {
    results.bghStatus = 'FAILED';
    const message = err instanceof Error ? err.message : String(err);
    console.error('❌ [3/3] Ngoại lệ khi đồng bộ cấu hình BGH lên Firebase:', message);
  }

  console.log('\n================================================================================');
  console.log(`🎉 KẾT QUẢ ĐỒNG BỘ: Users = ${results.usersStatus}, Docs = ${results.docsStatus}, BGH Config = ${results.bghStatus}`);
  console.log('================================================================================\n');

  return results;
}

if (require.main === module) {
  syncAll().then((results) => {
    const hasFailure = results.usersStatus === 'FAILED' ||
      results.docsStatus === 'FAILED' ||
      results.bghStatus === 'FAILED';

    if (hasFailure) {
      console.error('❌ Đồng bộ gặp sự cố tại một hoặc nhiều bước.');
      process.exit(1);
    } else {
      process.exit(0);
    }
  }).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('Lỗi khi chạy script đồng bộ:', message);
    process.exit(1);
  });
}

module.exports = { syncAll, buildAuthenticatedUrl, safeReadJson };

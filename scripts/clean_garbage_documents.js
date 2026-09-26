/**
 * ====================================================================================================
 * 🧹 SCRIPT DỌN DẸP DỮ LIỆU RÁC THỬ NGHIỆM HỒ SƠ VĂN BẢN (EduSign VGCA - THCS Chu Văn An)
 * ====================================================================================================
 * Mục đích:
 * 1. Làm sạch triệt để file local data/documents.json -> reset về mảng rỗng []
 * 2. Gửi lệnh xóa toàn bộ bản ghi rác trên Firebase Realtime Database (endpoint documents.json)
 * 3. Đảm bảo giao diện Quản trị và "Tiến độ hồ sơ của tôi" đạt 0 bản ghi rác
 * ====================================================================================================
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const DOCS_FILE = path.join(ROOT_DIR, 'data', 'documents.json');
const RTDB_URL = 'https://edusign-school-default-rtdb.asia-southeast1.firebasedatabase.app';

async function fetchWithTimeout(url, options = {}, timeoutMs = 6000) {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...options, signal: controller.signal });
  } finally {
    clearTimeout(timeoutId);
  }
}

async function cleanGarbageDocuments() {
  console.log('================================================================================');
  console.log(' 🧹 BẮT ĐẦU DỌN DẸP DỮ LIỆU RÁC THỬ NGHIỆM HỒ SƠ VĂN BẢN EDUSIGN VGCA');
  console.log('================================================================================\n');

  let localCleaned = false;
  let rtdbCleaned = false;

  // 1. Dọn dẹp local data/documents.json
  try {
    const dataDir = path.dirname(DOCS_FILE);
    if (!fs.existsSync(dataDir)) {
      fs.mkdirSync(dataDir, { recursive: true });
    }
    const previousContent = fs.existsSync(DOCS_FILE) ? fs.readFileSync(DOCS_FILE, 'utf8') : '[]';
    let prevCount = 0;
    try {
      const parsed = JSON.parse(previousContent);
      prevCount = Array.isArray(parsed) ? parsed.length : 0;
    } catch (parseErr) {
      console.warn('⚠️ [1/2] Cảnh báo parse data/documents.json trước đó:', parseErr.message);
      prevCount = 0;
    }

    fs.writeFileSync(DOCS_FILE, JSON.stringify([], null, 2), 'utf8');
    localCleaned = true;
    console.log(`✅ [1/2] Đã làm sạch data/documents.json: Xóa bỏ ${prevCount} bản ghi rác, reset về [].`);
  } catch (err) {
    console.error('❌ [1/2] Lỗi làm sạch data/documents.json:', err.message);
  }

  // 2. Dọn dẹp Firebase RTDB documents/
  try {
    const targetUrl = `${RTDB_URL}/documents.json`;
    console.log(`🌐 [2/2] Đang kết nối Firebase RTDB: ${targetUrl}...`);

    let res = null;
    try {
      res = await fetchWithTimeout(targetUrl, { method: 'DELETE' }, 6000);
    } catch (deleteErr) {
      console.warn(`⚠️ [2/2] DELETE gặp lỗi (${deleteErr.message}), kích hoạt thử lại với PUT []...`);
      res = await fetchWithTimeout(targetUrl, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify([])
      }, 6000);
    }

    if (res && (res.ok || res.status === 200 || res.status === 204)) {
      rtdbCleaned = true;
      console.log('✅ [2/2] Đã dọn dẹp sạch toàn bộ tài liệu rác trên Firebase RTDB (documents/) thành công!');
    } else {
      console.warn(`⚠️ [2/2] Phản hồi Firebase RTDB: Status ${res ? res.status : 'N/A'}`);
    }
  } catch (err) {
    console.warn(`⚠️ [2/2] Lưu ý Firebase RTDB (Offline hoặc mạng giới hạn): ${err.message}`);
  }

  console.log('\n================================================================================');
  console.log(`🎉 HOÀN TẤT DỌN DẸP DỮ LIỆU RÁC: Local File = ${localCleaned ? 'CLEANED' : 'FAILED'}, RTDB = ${rtdbCleaned ? 'CLEANED' : 'SKIPPED/OFFLINE'}`);
  console.log('================================================================================\n');

  return { localCleaned, rtdbCleaned };
}

if (require.main === module) {
  cleanGarbageDocuments().then(() => {
    process.exit(0);
  }).catch((err) => {
    console.error('Lỗi khi chạy script dọn dẹp:', err);
    process.exit(1);
  });
}

module.exports = { cleanGarbageDocuments };

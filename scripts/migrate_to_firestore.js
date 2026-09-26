/**
 * ====================================================================================================
 * 🚀 SCRIPT DI CHUYỂN DỮ LIỆU TỪ LOCAL LÊN GOOGLE CLOUD FIRESTORE (EduSign VGCA - THCS Chu Văn An)
 * ====================================================================================================
 * Mục đích:
 * 1. Khởi tạo kết nối Google Cloud Firestore thông qua Service Account Key
 * 2. Đọc và kiểm tra an toàn dữ liệu từ data/users.json, data/documents.json, data/bgh_signing_config.json
 * 3. Lọc bỏ các trường nhạy cảm (mật khẩu, khóa riêng) và nhị phân Base64 nặng trước khi ghi
 * 4. Xử lý ghi hàng loạt (batch write) với giới hạn chunk tối đa 400 bản ghi/lần (Firestore limit = 500)
 * ====================================================================================================
 */

const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const SERVICE_ACCOUNT_PATH = process.env.GOOGLE_APPLICATION_CREDENTIALS || path.join(ROOT_DIR, 'serviceAccountKey.json');
const USERS_FILE = path.join(ROOT_DIR, 'data', 'users.json');
const DOCS_FILE = path.join(ROOT_DIR, 'data', 'documents.json');
const BGH_CONFIG_FILE = path.join(ROOT_DIR, 'data', 'bgh_signing_config.json');

const SENSITIVE_USER_FIELDS = [
  'password', 'passwordHash', 'salt', 'token', 'accessToken',
  'refreshToken', 'secret', 'privateKey', 'authSecret', 'sessionToken'
];

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

/**
 * Chuẩn hóa và làm sạch thông tin tài khoản người dùng trước khi ghi Firestore
 */
function sanitizeUserRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : (typeof raw.username === 'string' ? raw.username.trim() : '');
  if (!id) {
    return null;
  }
  const clean = { ...raw, id };
  for (const field of SENSITIVE_USER_FIELDS) {
    delete clean[field];
  }
  return clean;
}

/**
 * Chuẩn hóa và loại bỏ các trường Base64 nặng của hồ sơ trước khi ghi Firestore
 */
function sanitizeDocRecord(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return null;
  }
  const id = typeof raw.id === 'string' ? raw.id.trim() : '';
  if (!id) {
    return null;
  }
  const clean = { ...raw, id };
  delete clean.fileBase64;
  delete clean.signedPdfBase64;
  delete clean.rawContent;
  return clean;
}

async function migrateToFirestore() {
  console.log('═══════════════════════════════════════════════════════════════');
  console.log('🚀 CÔNG CỤ DI CHUYỂN DỮ LIỆU LÊN GOOGLE CLOUD FIRESTORE');
  console.log('═══════════════════════════════════════════════════════════════\n');

  if (!fs.existsSync(SERVICE_ACCOUNT_PATH)) {
    console.warn('⚠️  CHƯA TÌM THẤY TỆP SERVICE ACCOUNT KEY: ' + SERVICE_ACCOUNT_PATH);
    console.warn('👉 Hướng dẫn chuẩn bị:');
    console.warn('   1. Truy cập https://console.firebase.google.com');
    console.warn('   2. Vào Project Settings -> Service accounts -> Bấm [Generate new private key]');
    console.warn('   3. Đổi tên file tải về thành: serviceAccountKey.json và đặt vào thư mục gốc dự án:');
    console.warn(`      ${SERVICE_ACCOUNT_PATH}`);
    console.warn('   4. Chạy lại lệnh này sau khi hoàn tất.\n');
    return { success: false, reason: 'SERVICE_ACCOUNT_KEY_NOT_FOUND' };
  }

  let admin;
  try {
    admin = require('firebase-admin');
  } catch (requireErr) {
    console.error('❌ Thư viện firebase-admin chưa được cài đặt trong môi trường.');
    console.error('👉 Vui lòng chạy lệnh: npm install firebase-admin');
    return { success: false, reason: 'FIREBASE_ADMIN_NOT_INSTALLED' };
  }

  const serviceAccount = safeReadJson(SERVICE_ACCOUNT_PATH);
  if (!serviceAccount || typeof serviceAccount !== 'object') {
    console.error('❌ Tệp serviceAccountKey.json bị hỏng hoặc không đúng định dạng JSON.');
    return { success: false, reason: 'INVALID_SERVICE_ACCOUNT_JSON' };
  }

  if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
    console.error('❌ Tệp serviceAccountKey.json thiếu một trong các trường bắt buộc: project_id, client_email, private_key.');
    return { success: false, reason: 'INCOMPLETE_SERVICE_ACCOUNT_CREDENTIALS' };
  }

  try {
    if (!admin.apps.length) {
      admin.initializeApp({
        credential: admin.credential.cert(serviceAccount)
      });
    }
  } catch (initErr) {
    const message = initErr instanceof Error ? initErr.message : String(initErr);
    console.error('❌ Khởi tạo Firebase Admin SDK thất bại:', message);
    return { success: false, reason: 'FIREBASE_INIT_FAILED' };
  }

  const db = admin.firestore();
  console.log(`✅ Đã kết nối thành công đến Firebase Project: ${serviceAccount.project_id}\n`);

  let totalUsersMigrated = 0;
  let totalDocsMigrated = 0;
  let bghMigrated = false;

  // 1. Đồng bộ người dùng (users)
  try {
    const rawUsers = safeReadJson(USERS_FILE);
    if (rawUsers !== null) {
      if (!Array.isArray(rawUsers)) {
        console.warn('⚠️ [1/3] data/users.json không phải là mảng hợp lệ, bỏ qua.');
      } else {
        const validUsers = rawUsers.map(sanitizeUserRecord).filter(Boolean);
        console.log(`📤 [1/3] Đang tải lên ${validUsers.length}/${rawUsers.length} tài khoản người dùng hợp lệ...`);

        const chunkSize = 400;
        for (let i = 0; i < validUsers.length; i += chunkSize) {
          const chunk = validUsers.slice(i, i + chunkSize);
          const batch = db.batch();
          for (const u of chunk) {
            const ref = db.collection('users').doc(u.id);
            batch.set(ref, u, { merge: true });
          }
          await batch.commit();
        }
        totalUsersMigrated = validUsers.length;
        console.log(`✅ [1/3] Đã đồng bộ ${validUsers.length} người dùng vào collection "users"!`);
      }
    } else {
      console.log('ℹ️ [1/3] Tệp data/users.json không tồn tại hoặc rỗng, bỏ qua.');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('❌ [1/3] Ngoại lệ khi đồng bộ users lên Firestore:', message);
    return { success: false, reason: 'USERS_MIGRATION_ERROR' };
  }

  // 2. Đồng bộ hồ sơ (documents) - Đã làm sạch Base64
  try {
    const rawDocs = safeReadJson(DOCS_FILE);
    if (rawDocs !== null) {
      if (!Array.isArray(rawDocs)) {
        console.warn('⚠️ [2/3] data/documents.json không phải là mảng hợp lệ, bỏ qua.');
      } else {
        const validDocs = rawDocs.map(sanitizeDocRecord).filter(Boolean);
        console.log(`📤 [2/3] Đang tải lên ${validDocs.length}/${rawDocs.length} hồ sơ giáo án hợp lệ...`);

        const chunkSize = 400;
        for (let i = 0; i < validDocs.length; i += chunkSize) {
          const chunk = validDocs.slice(i, i + chunkSize);
          const batch = db.batch();
          for (const d of chunk) {
            const ref = db.collection('documents').doc(d.id);
            batch.set(ref, d, { merge: true });
          }
          await batch.commit();
          console.log(`   -> Đã ghi ${Math.min(i + chunkSize, validDocs.length)}/${validDocs.length} hồ sơ...`);
        }
        totalDocsMigrated = validDocs.length;
        console.log(`✅ [2/3] Đã đồng bộ ${validDocs.length} hồ sơ vào collection "documents"!`);
      }
    } else {
      console.log('ℹ️ [2/3] Tệp data/documents.json không tồn tại hoặc rỗng, bỏ qua.');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('❌ [2/3] Ngoại lệ khi đồng bộ documents lên Firestore:', message);
    return { success: false, reason: 'DOCUMENTS_MIGRATION_ERROR' };
  }

  // 3. Đồng bộ cấu hình BGH USB Token
  try {
    const rawBgh = safeReadJson(BGH_CONFIG_FILE);
    if (rawBgh !== null) {
      if (typeof rawBgh !== 'object' || Array.isArray(rawBgh)) {
        console.warn('⚠️ [3/3] data/bgh_signing_config.json không phải đối tượng hợp lệ, bỏ qua.');
      } else {
        const safeCfg = { ...rawBgh };
        delete safeCfg.pin;
        delete safeCfg.privateKey;
        delete safeCfg.secret;

        console.log('📤 [3/3] Đang tải lên cấu hình Chữ ký số BGH...');
        await db.collection('configs').doc('bgh_signing_config').set(safeCfg, { merge: true });
        bghMigrated = true;
        console.log('✅ [3/3] Đã đồng bộ cấu hình BGH vào collection "configs"!');
      }
    } else {
      console.log('ℹ️ [3/3] Tệp data/bgh_signing_config.json không tồn tại hoặc rỗng, bỏ qua.');
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    console.error('❌ [3/3] Ngoại lệ khi đồng bộ cấu hình BGH lên Firestore:', message);
    return { success: false, reason: 'BGH_CONFIG_MIGRATION_ERROR' };
  }

  console.log('\n================================================================================');
  console.log(`🎉 DI CHUYỂN DỮ LIỆU LÊN CLOUD FIRESTORE HOÀN TẤT! (Users: ${totalUsersMigrated}, Docs: ${totalDocsMigrated}, BGH: ${bghMigrated ? 'YES' : 'NO'})`);
  console.log('================================================================================\n');

  return {
    success: true,
    totalUsersMigrated,
    totalDocsMigrated,
    bghMigrated
  };
}

if (require.main === module) {
  migrateToFirestore().then((result) => {
    if (result && result.success) {
      process.exit(0);
    } else {
      process.exit(1);
    }
  }).catch((err) => {
    const message = err instanceof Error ? err.message : String(err);
    console.error('❌ Lỗi ngoại lệ khi di chuyển dữ liệu:', message);
    process.exit(1);
  });
}

module.exports = {
  migrateToFirestore,
  sanitizeUserRecord,
  sanitizeDocRecord,
  safeReadJson
};

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const USERS_FILE = path.join(DATA_DIR, 'users.json');
const DOCS_FILE = path.join(DATA_DIR, 'documents.json');
const DEPTS_FILE = path.join(DATA_DIR, 'departments.json');
const SUBS_FILE = path.join(DATA_DIR, 'subscriptions.json');

// Đảm bảo thư mục data tồn tại an toàn và thực sự là một thư mục khi khởi động
try {
  const stat = fs.statSync(DATA_DIR);
  if (!stat.isDirectory()) {
    throw new Error(`[dataStore] Lỗi nghiêm trọng: DATA_DIR [${DATA_DIR}] không phải là thư mục hợp lệ (ENOTDIR).`);
  }
} catch (statErr) {
  if (statErr.code === 'ENOENT') {
    try {
      fs.mkdirSync(DATA_DIR, { recursive: true });
    } catch (mkdirErr) {
      throw new Error(`[dataStore] Lỗi nghiêm trọng khi tạo DATA_DIR [${DATA_DIR}]: ${mkdirErr.message}`);
    }
  } else {
    throw new Error(`[dataStore] Lỗi nghiêm trọng khi truy cập DATA_DIR [${DATA_DIR}]: ${statErr.message}`);
  }
}

// Ghi tệp khởi tạo nguyên tử bằng tệp tạm mở độc quyền (wx) và đổi tên an toàn chống rách tệp / tranh chấp worker
function writeInitFileAtomic(filePath, data) {
  const content = JSON.stringify(data, null, 2);
  let tempPath = null;
  let fd = null;

  // Tạo tệp tạm với tên ngẫu nhiên cryptographically secure và mở độc quyền (flag 'wx')
  for (let i = 0; i < 5; i++) {
    const candidatePath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(16).toString('hex')}.tmp`;
    try {
      fd = fs.openSync(candidatePath, 'wx');
      tempPath = candidatePath;
      break;
    } catch (openErr) {
      if (openErr && openErr.code === 'EEXIST') {
        continue;
      }
      throw new Error(`[dataStore writeInitFileAtomic] Không thể mở tệp tạm độc quyền cho [${filePath}]: ${openErr.message}`);
    }
  }

  if (!tempPath || fd === null) {
    throw new Error(`[dataStore writeInitFileAtomic] Thất bại khi cấp phát tệp tạm độc quyền cho [${filePath}].`);
  }

  try {
    fs.writeFileSync(fd, content, 'utf8');
    fs.closeSync(fd);
    fd = null;
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    if (fd !== null) {
      try {
        fs.closeSync(fd);
      } catch (cErr) {
        if (cErr && cErr.code !== 'EBADF') {
          console.warn(`[dataStore writeInitFileAtomic] Cảnh báo lỗi khi đóng descriptor: ${(cErr && cErr.message) || cErr}`);
        }
      }
    }
    if (tempPath && fs.existsSync(tempPath)) {
      try {
        fs.unlinkSync(tempPath);
      } catch (uErr) {
        if (uErr && uErr.code !== 'ENOENT') {
          console.warn(`[dataStore writeInitFileAtomic] Cảnh báo lỗi khi xóa tệp tạm [${tempPath}]: ${(uErr && uErr.message) || uErr}`);
        }
      }
    }

    const safeErrMsg = (err && typeof err === 'object' && typeof err.message === 'string') ? err.message : String(err);

    // Chỉ xử lý như tranh chấp đổi tên khi mã lỗi xác định rõ tệp đích đã tồn tại (EEXIST)
    if (err && typeof err === 'object' && err.code === 'EEXIST') {
      try {
        validateDataFileSchema(filePath);
        return; // Tệp đích đã được worker khác khởi tạo hợp lệ theo đúng cấu trúc nghiệp vụ
      } catch (validateErr) {
        const valErrMsg = (validateErr && typeof validateErr === 'object' && typeof validateErr.message === 'string') ? validateErr.message : String(validateErr);
        throw new Error(`[dataStore] Giao dịch khởi tạo [${filePath}] gặp xung đột và tệp hiện hữu không hợp lệ: ${valErrMsg}`);
      }
    }

    // Mọi lỗi quyền (EACCES/EPERM), ổ đĩa khóa (EBUSY), tràn bộ nhớ (ENOSPC) hay lỗi I/O khác bắt buộc ném lỗi ngay
    throw new Error(`[dataStore] Lỗi hệ thống khi khởi tạo tệp [${filePath}]: ${safeErrMsg}`);
  }
}

// Xác thực tính toàn vẹn và schema dữ liệu của tệp JSON hiện hữu
function validateDataFileSchema(filePath) {
  if (!fs.existsSync(filePath)) {
    throw new Error(`Tệp [${filePath}] không tồn tại trên hệ thống tệp.`);
  }
  const content = fs.readFileSync(filePath, 'utf8');
  let parsed;
  try {
    parsed = JSON.parse(content);
  } catch (jsonErr) {
    throw new Error(`Tệp [${filePath}] chứa định dạng JSON không hợp lệ: ${jsonErr.message}`);
  }
  if (!Array.isArray(parsed)) {
    throw new Error(`Tệp [${filePath}] không phải là một mảng JSON hợp lệ.`);
  }
  if (filePath === USERS_FILE) {
    const admin = parsed.find(u => u && typeof u === 'object' && u.id === 'admin');
    if (!admin
      || typeof admin.id !== 'string' || admin.id.trim().length === 0
      || typeof admin.username !== 'string' || admin.username.trim().length === 0
      || typeof admin.password !== 'string' || admin.password.trim().length === 0
      || typeof admin.role !== 'string' || admin.role.trim().length === 0) {
      throw new Error('Tệp users.json hiện hữu thiếu tài khoản Quản trị viên chuẩn schema (id, username, password, role bắt buộc là chuỗi ký tự không rỗng).');
    }
  } else if (filePath === DEPTS_FILE) {
    if (parsed.length === 0 || !parsed.every(d =>
      d && typeof d === 'object'
      && typeof d.id === 'string' && d.id.trim().length > 0
      && typeof d.name === 'string' && d.name.trim().length > 0
    )) {
      throw new Error('Tệp departments.json hiện hữu phải chứa các tổ chuyên môn với thuộc tính id và name là chuỗi ký tự không rỗng.');
    }
  }
  return parsed;
}

// Khởi tạo danh sách tổ chuyên môn mặc định nếu chưa có, hoặc xác thực nếu đã tồn tại
function initDefaultDepts() {
  if (!fs.existsSync(DEPTS_FILE)) {
    const defaultDepts = [
      { id: 'dept_bgh', name: 'Ban Giám hiệu', code: 'BGH', description: 'Lãnh đạo và quản lý toàn diện các hoạt động nhà trường', leaderId: 'admin', createdAt: new Date().toISOString() },
      { id: 'dept_toan_tin', name: 'Tổ Toán - Tin', code: 'TOAN_TIN', description: 'Tổ chuyên môn Toán học và Tin học', leaderId: null, createdAt: new Date().toISOString() },
      { id: 'dept_ngu_van', name: 'Tổ Ngữ Văn', code: 'NGU_VAN', description: 'Tổ chuyên môn Ngữ văn và Nghệ thuật', leaderId: null, createdAt: new Date().toISOString() },
      { id: 'dept_ngoai_ngu', name: 'Tổ Ngoại Ngữ', code: 'NGOAI_NGU', description: 'Tổ chuyên môn Tiếng Anh', leaderId: null, createdAt: new Date().toISOString() },
      { id: 'dept_khtn', name: 'Tổ Khoa học Tự nhiên', code: 'KHTN', description: 'Tổ chuyên môn Vật lý, Hóa học, Sinh học', leaderId: null, createdAt: new Date().toISOString() },
      { id: 'dept_ls_dl', name: 'Tổ Lịch sử - Địa lý', code: 'LS_DL', description: 'Tổ chuyên môn Lịch sử, Địa lý, GDCD', leaderId: null, createdAt: new Date().toISOString() },
      { id: 'dept_gdtc_nt', name: 'Tổ Giáo dục Thể chất - Nghệ thuật', code: 'GDTC_NT', description: 'Tổ chuyên môn Thể dục, Âm nhạc, Mỹ thuật', leaderId: null, createdAt: new Date().toISOString() },
      { id: 'dept_van_phong', name: 'Văn phòng nhà trường', code: 'VAN_PHONG', description: 'Bộ phận hành chính, kế toán, văn thư, y tế', leaderId: null, createdAt: new Date().toISOString() }
    ];
    writeInitFileAtomic(DEPTS_FILE, defaultDepts);
  } else {
    try {
      validateDataFileSchema(DEPTS_FILE);
    } catch (err) {
      throw new Error(`[dataStore initDefaultDepts] Tệp departments.json hiện hữu không hợp lệ: ${err.message}`);
    }
  }
}

// Khởi tạo danh sách đăng ký thông báo Web Push nếu chưa có, hoặc xác thực nếu đã tồn tại
function initDefaultSubscriptions() {
  if (!fs.existsSync(SUBS_FILE)) {
    writeInitFileAtomic(SUBS_FILE, []);
  } else {
    try {
      validateDataFileSchema(SUBS_FILE);
    } catch (err) {
      throw new Error(`[dataStore initDefaultSubscriptions] Tệp subscriptions.json hiện hữu không hợp lệ: ${err.message}`);
    }
  }
}

const util = require('util');
const pbkdf2Async = util.promisify(crypto.pbkdf2);

const PBKDF2_ITERATIONS = (process.env.NODE_ENV === 'test') ? 1000 : 310000;
const MIN_PBKDF2_ITERATIONS = 1000;
const MAX_PBKDF2_ITERATIONS = 1000000;
const HEX_REGEX = /^[0-9a-fA-F]+$/;

// Hàm băm mật khẩu bất đồng bộ an toàn chuẩn OWASP với Salt & PBKDF2-HMAC-SHA512
async function hashPassword(password, salt = null, iterations = PBKDF2_ITERATIONS) {
  if (password === null || password === undefined || typeof password !== 'string' || password.length === 0) {
    throw new TypeError('[dataStore hashPassword] Mật khẩu bắt buộc phải là một chuỗi ký tự không rỗng.');
  }
  const currentSalt = (salt && typeof salt === 'string' && salt.length >= 16 && salt.length <= 128 && HEX_REGEX.test(salt))
    ? salt
    : crypto.randomBytes(16).toString('hex');
  const validIterations = (typeof iterations === 'number' && Number.isInteger(iterations) && iterations >= MIN_PBKDF2_ITERATIONS && iterations <= MAX_PBKDF2_ITERATIONS)
    ? iterations
    : PBKDF2_ITERATIONS;
  const derivedKey = await pbkdf2Async(password, currentSalt, validIterations, 64, 'sha512');
  return `pbkdf2:sha512:${validIterations}:${currentSalt}:${derivedKey.toString('hex')}`;
}

// Băm đồng bộ phục vụ riêng khởi tạo bootstrap ban đầu
function hashPasswordSync(password, salt = null, iterations = PBKDF2_ITERATIONS) {
  if (password === null || password === undefined || typeof password !== 'string' || password.length === 0) {
    throw new TypeError('[dataStore hashPasswordSync] Mật khẩu bắt buộc phải là một chuỗi ký tự không rỗng.');
  }
  const currentSalt = (salt && typeof salt === 'string' && salt.length >= 16 && salt.length <= 128 && HEX_REGEX.test(salt))
    ? salt
    : crypto.randomBytes(16).toString('hex');
  const validIterations = (typeof iterations === 'number' && Number.isInteger(iterations) && iterations >= MIN_PBKDF2_ITERATIONS && iterations <= MAX_PBKDF2_ITERATIONS)
    ? iterations
    : PBKDF2_ITERATIONS;
  const hash = crypto.pbkdf2Sync(password, currentSalt, validIterations, 64, 'sha512').toString('hex');
  return `pbkdf2:sha512:${validIterations}:${currentSalt}:${hash}`;
}

// Đối soát mật khẩu thời gian thực (Timing-Safe) bất đồng bộ, xác thực nghiêm ngặt cấu trúc và phạm vi vòng lặp
async function verifyPassword(plainPassword, storedPassword) {
  if (!plainPassword || !storedPassword || typeof plainPassword !== 'string' || typeof storedPassword !== 'string') {
    return false;
  }
  try {
    if (storedPassword.startsWith('pbkdf2:')) {
      const parts = storedPassword.split(':');
      if (parts.length === 5 && parts[1] === 'sha512') {
        if (!/^\d+$/.test(parts[2])) {
          return false;
        }
        const iterations = Number(parts[2]);
        if (!Number.isInteger(iterations) || iterations < MIN_PBKDF2_ITERATIONS || iterations > MAX_PBKDF2_ITERATIONS) {
          return false;
        }
        const salt = parts[3];
        const expectedHash = parts[4];
        if (!salt || salt.length < 16 || salt.length > 128 || !HEX_REGEX.test(salt)) {
          return false;
        }
        if (!expectedHash || expectedHash.length !== 128 || !HEX_REGEX.test(expectedHash)) {
          return false;
        }
        const actualKey = await pbkdf2Async(plainPassword, salt, iterations, 64, 'sha512');
        const bActual = Buffer.from(actualKey.toString('hex'), 'utf8');
        const bExpected = Buffer.from(expectedHash, 'utf8');
        if (bActual.length !== bExpected.length) return false;
        return crypto.timingSafeEqual(bActual, bExpected);
      } else if (parts.length === 3) {
        // Định dạng legacy pbkdf2:salt:hash với 10000 vòng lặp
        const salt = parts[1];
        const expectedHash = parts[2];
        if (!salt || salt.length < 16 || salt.length > 128 || !HEX_REGEX.test(salt)) {
          return false;
        }
        if (!expectedHash || expectedHash.length !== 128 || !HEX_REGEX.test(expectedHash)) {
          return false;
        }
        const actualKey = await pbkdf2Async(plainPassword, salt, 10000, 64, 'sha512');
        const bActual = Buffer.from(actualKey.toString('hex'), 'utf8');
        const bExpected = Buffer.from(expectedHash, 'utf8');
        if (bActual.length !== bExpected.length) return false;
        return crypto.timingSafeEqual(bActual, bExpected);
      }
      return false;
    }

    // Cơ chế chuyển tiếp an toàn (Migration) cho mật khẩu plaintext cũ:
    // So sánh thời gian thực (Timing-Safe) tuyệt đối, không có so sánh lỏng fallback
    const b1 = Buffer.from(plainPassword, 'utf8');
    const b2 = Buffer.from(storedPassword, 'utf8');
    if (b1.length !== b2.length) return false;
    return crypto.timingSafeEqual(b1, b2);
  } catch (err) {
    return false;
  }
}

// Khởi tạo tài khoản Quản trị viên ban đầu qua cơ chế Bootstrap an toàn (Không hardcode plaintext hay credential nhạy cảm)
function initDefaultUsers() {
  if (!fs.existsSync(USERS_FILE)) {
    // Chặn kích hoạt chế độ test giả lập trên môi trường sản xuất thực tế
    if (process.env.NODE_ENV === 'test' && (process.env.NODE_ENV_PROD === 'production' || process.env.PRODUCTION === 'true')) {
      throw new Error('[dataStore initDefaultUsers] Nghiêm cấm chạy chế độ test trên môi trường sản xuất thực tế.');
    }

    // Ưu tiên đọc từ biến môi trường để triệt tiêu hoàn toàn credential cố định trong mã nguồn
    const bootstrapPass = (process.env.INITIAL_ADMIN_PASSWORD || process.env.ADMIN_INITIAL_PASSWORD || '').trim();
    let adminPassword = bootstrapPass;

    if (!adminPassword) {
      if (process.env.NODE_ENV === 'test') {
        const testPass = (process.env.TEST_ADMIN_PASSWORD || '').trim();
        if (!testPass) {
          throw new Error('[dataStore initDefaultUsers] Chế độ test yêu cầu biến môi trường TEST_ADMIN_PASSWORD không được rỗng.');
        }
        adminPassword = testPass;
      } else {
        throw new Error('[dataStore initDefaultUsers] Bắt buộc cấu hình biến môi trường INITIAL_ADMIN_PASSWORD hoặc ADMIN_INITIAL_PASSWORD để khởi tạo tài khoản Quản trị viên ban đầu.');
      }
    }

    let adminEmail = '';
    let adminCccd = '';
    let adminPin = '';

    if (process.env.NODE_ENV === 'test') {
      adminEmail = (process.env.TEST_ADMIN_EMAIL || 'admin@thcschuvanan.edu.vn').trim();
      adminCccd = (process.env.TEST_ADMIN_CCCD || '001085000001').trim();
      adminPin = (process.env.TEST_ADMIN_PIN || '0001').trim();
    } else {
      adminEmail = (process.env.ADMIN_EMAIL || '').trim();
      adminCccd = (process.env.ADMIN_CCCD || '').trim();
      adminPin = (process.env.ADMIN_PIN || '').trim();

      if (!adminEmail) {
        throw new Error('[dataStore initDefaultUsers] Bắt buộc cấu hình biến môi trường ADMIN_EMAIL cho tài khoản Quản trị viên trong môi trường sản xuất.');
      }
      if (!adminPin) {
        throw new Error('[dataStore initDefaultUsers] Bắt buộc cấu hình biến môi trường ADMIN_PIN cho tài khoản Quản trị viên trong môi trường sản xuất.');
      }
      if (!adminCccd) {
        throw new Error('[dataStore initDefaultUsers] Bắt buộc cấu hình biến môi trường ADMIN_CCCD cho tài khoản Quản trị viên trong môi trường sản xuất.');
      }
    }

    const defaultUsers = [
      {
        id: 'admin',
        username: 'admin',
        password: hashPasswordSync(adminPassword),
        name: 'Ban Giám hiệu - Quản trị viên',
        role: 'ADMIN',
        roleTitle: 'Quản trị viên nhà trường',
        department: 'Ban Giám hiệu',
        departmentId: 'dept_bgh',
        signType: 'USB_TOKEN',
        status: 'ACTIVE',
        email: adminEmail,
        officialEmail: adminEmail,
        cccd: adminCccd,
        certSerial: (process.env.ADMIN_CERT_SERIAL || '').trim(),
        school: 'TRƯỜNG TRUNG HỌC CƠ SỞ CHU VĂN AN',
        phone: (process.env.ADMIN_PHONE || '').trim(),
        pinCode: adminPin,
        mustChangePassword: true,
        createdAt: new Date().toISOString()
      }
    ];
    writeInitFileAtomic(USERS_FILE, defaultUsers);
  } else {
    try {
      validateDataFileSchema(USERS_FILE);
    } catch (err) {
      throw new Error(`[dataStore initDefaultUsers] Tệp users.json hiện hữu không hợp lệ: ${err.message}`);
    }
  }
}

// Khởi tạo danh sách tài liệu trống nếu chưa có, hoặc xác thực nếu đã tồn tại
function initDefaultDocs() {
  if (!fs.existsSync(DOCS_FILE)) {
    writeInitFileAtomic(DOCS_FILE, []);
  } else {
    try {
      validateDataFileSchema(DOCS_FILE);
    } catch (err) {
      throw new Error(`[dataStore initDefaultDocs] Tệp documents.json hiện hữu không hợp lệ: ${err.message}`);
    }
  }
}

initDefaultDepts();
initDefaultSubscriptions();
initDefaultUsers();
initDefaultDocs();

const DEPARTMENTS = [
  'Tổ Toán - Tin',
  'Tổ Ngữ Văn',
  'Tổ Ngoại Ngữ',
  'Tổ Khoa học Tự nhiên',
  'Tổ Lịch sử - Địa lý',
  'Tổ Giáo dục Thể chất - Nghệ thuật',
  'Văn phòng nhà trường',
  'Ban Giám hiệu'
];

function readJsonSafe(filePath, defaultVal = []) {
  if (!fs.existsSync(filePath)) {
    return defaultVal;
  }
  let rawData = '';
  try {
    rawData = fs.readFileSync(filePath, 'utf8');
  } catch (ioErr) {
    console.error(`[dataStore readJsonSafe] Lỗi I/O khi đọc tệp [${filePath}]:`, ioErr.message);
    throw new Error(`[dataStore readJsonSafe] Không thể đọc tệp [${filePath}]: ${ioErr.message}`);
  }
  try {
    if (rawData.charCodeAt(0) === 0xFEFF) {
      rawData = rawData.slice(1);
    }
    const trimmed = rawData.trim();
    if (!trimmed) {
      console.warn(`[dataStore readJsonSafe] Cảnh báo: Tệp [${filePath}] rỗng nội dung.`);
      return defaultVal;
    }
    return JSON.parse(trimmed);
  } catch (parseErr) {
    console.error(`[dataStore readJsonSafe] Lỗi định dạng JSON trong tệp [${filePath}]:`, parseErr.message);
    throw new Error(`[dataStore readJsonSafe] Tệp dữ liệu [${filePath}] bị lỗi cú pháp JSON: ${parseErr.message}`);
  }
}

// =================== CƠ CHẾ HÀNG ĐỢI GHI ĐĨA BẤT ĐỒNG BỘ & BỘ NHỚ ĐỆM ===================
let _usersCache = null;
let _usersFileMtime = 0;
let _usersFileSize = 0;
let _usersContentHash = '';

// Đọc danh sách người dùng (tự động invalidate cache khi mtime, size hoặc content hash SHA-256 thay đổi)
function getUsers(forceReload = false) {
  try {
    if (!fs.existsSync(USERS_FILE)) {
      _usersCache = [];
      _usersFileMtime = 0;
      _usersFileSize = 0;
      _usersContentHash = '';
      return [];
    }

    const stat = fs.statSync(USERS_FILE);
    const currentMtime = stat.mtimeMs;
    const currentSize = stat.size;

    // Đọc và kiểm tra nội dung khi nạp dữ liệu
    const rawBuffer = fs.readFileSync(USERS_FILE);
    const currentHash = crypto.createHash('sha256').update(rawBuffer).digest('hex');

    // Xác thực cache tuyệt đối bằng mã băm SHA-256 nội dung tệp thực tế:
    if (!forceReload && _usersCache !== null && currentHash === _usersContentHash) {
      _usersFileMtime = currentMtime;
      _usersFileSize = currentSize;
      return _usersCache;
    }

    let rawData = [];
    try {
      let str = rawBuffer.toString('utf8');
      if (str.charCodeAt(0) === 0xFEFF) str = str.slice(1);
      const trimmed = str.trim();
      if (trimmed) {
        rawData = JSON.parse(trimmed);
      }
    } catch (parseErr) {
      console.warn(`[dataStore getUsers] Cảnh báo lỗi parse JSON từ buffer, fallback đọc qua readJsonSafe: ${parseErr.message}`);
      rawData = readJsonSafe(USERS_FILE, []);
    }

    _usersCache = Array.isArray(rawData) ? rawData : [];
    _usersFileMtime = currentMtime;
    _usersFileSize = currentSize;
    _usersContentHash = currentHash;
    return _usersCache;
  } catch (err) {
    const errMsg = (err && typeof err === 'object' && typeof err.message === 'string') ? err.message : String(err);
    console.error(`[dataStore getUsers] Lỗi khi đọc USERS_FILE: ${errMsg}`);
    return _usersCache || [];
  }
}

// Dọn dẹp các tệp tạm .tmp mồ côi tồn đọng từ các phiên làm việc trước (chỉ xóa tệp cũ hơn 5 phút)
function cleanupStaleTempFiles() {
  try {
    const dataDir = path.dirname(USERS_FILE);
    if (!fs.existsSync(dataDir)) return;
    const now = Date.now();
    const maxAge = 5 * 60 * 1000;
    const files = fs.readdirSync(dataDir);
    for (const f of files) {
      if (!f.endsWith('.tmp')) continue;
      if (!f.startsWith('users.json.') && !f.startsWith('documents.json.') && !f.startsWith('departments.json.') && !f.startsWith('subscriptions.json.')) continue;
      try {
        const tmpFilePath = path.join(dataDir, f);
        const stat = fs.statSync(tmpFilePath);
        if (now - stat.mtimeMs > maxAge) {
          fs.unlinkSync(tmpFilePath);
        }
      } catch (err) {
        if (err && err.code !== 'ENOENT') {
          console.warn('[dataStore Init] Không thể xóa tệp tmp cũ:', err.message);
        }
      }
    }
  } catch (cleanTmpErr) {
    console.warn('[dataStore Init] Lỗi quét thư mục data:', cleanTmpErr.message);
  }
}
cleanupStaleTempFiles();

/**
 * Ghi tệp JSON bất đồng bộ an toàn với cơ chế retry phi nghẽn (non-blocking).
 * TUYỆT ĐỐI KHÔNG dùng Atomics.wait gây đóng băng V8 Event Loop.
 */
async function _writeJsonAsyncWithRetry(filePath, data, maxAttempts = 12) {
  if (!filePath || typeof filePath !== 'string') {
    throw new TypeError(`[dataStore _writeJsonAsyncWithRetry] filePath bắt buộc phải là một chuỗi ký tự hợp lệ.`);
  }
  if (!Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new RangeError(`[dataStore _writeJsonAsyncWithRetry] maxAttempts phải là số nguyên dương lớn hơn hoặc bằng 1 (nhận được: ${maxAttempts})`);
  }

  let content;
  try {
    content = JSON.stringify(data, null, 2);
  } catch (err) {
    throw new TypeError(`[dataStore _writeJsonAsyncWithRetry] Không thể serialize dữ liệu JSON cho [${filePath}]: ${err.message}`);
  }

  let tempPath = null;
  let lastErr = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      tempPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(8).toString('hex')}.tmp`;
      await fs.promises.writeFile(tempPath, content, 'utf8');
      await fs.promises.rename(tempPath, filePath);
      return;
    } catch (err) {
      lastErr = err;
      if (tempPath) {
        try {
          if (fs.existsSync(tempPath)) {
            await fs.promises.unlink(tempPath);
          }
        } catch (unlinkTempErr) {
          if (unlinkTempErr && unlinkTempErr.code !== 'ENOENT') {
            console.warn('[dataStore] Lỗi dọn tệp tạm khi lỗi ghi:', unlinkTempErr.message);
          }
        }
      }
      if (attempt === maxAttempts - 1) {
        const lastErrMsg = (lastErr && typeof lastErr === 'object' && typeof lastErr.message === 'string') ? lastErr.message : String(lastErr);
        throw new Error(`[dataStore] Giao dịch ghi file bất đồng bộ thất bại sau ${maxAttempts} lần thử cho [${filePath}]: ${lastErrMsg}`);
      }
      // Non-blocking backoff delay: nhường CPU cho Event Loop xử lý các request khác
      const delay = Math.min(200, 15 * Math.pow(1.3, attempt) + Math.random() * 10);
      await new Promise(r => setTimeout(r, delay));
    }
  }
}

// Quản lý hàng đợi ghi đĩa tuần tự độc lập cho từng file đường dẫn (Serialized Queue)
const _fileQueues = new Map();

function _getFileQueue(filePath) {
  const normalizedPath = path.resolve(filePath);
  let q = _fileQueues.get(normalizedPath);
  if (!q) {
    q = {
      isWriting: false,
      hasPending: false,
      pendingData: null,
      resolvers: []
    };
    _fileQueues.set(normalizedPath, q);
  }
  return q;
}

function _hasPendingWrites(filePath) {
  const normalizedPath = path.resolve(filePath);
  const q = _fileQueues.get(normalizedPath);
  return q ? (q.isWriting || q.hasPending) : false;
}

function _queueFileSave(filePath, data) {
  if (!filePath) return Promise.resolve(true);
  const normalizedPath = path.resolve(filePath);
  const q = _getFileQueue(normalizedPath);

  q.pendingData = data;

  const promise = new Promise((resolve, reject) => {
    q.resolvers.push({ resolve, reject });

    if (q.isWriting) {
      // Đã có luồng ghi đang chạy -> đánh dấu pending để gom đợt ghi tiếp theo (coalescing)
      q.hasPending = true;
      return;
    }

    _processFileQueue(normalizedPath, q);
  });

  // Bắt lỗi ngầm có ghi nhận log an toàn để tránh unhandledRejection
  promise.catch((err) => {
    const message = (err && typeof err === 'object' && typeof err.message === 'string')
      ? err.message
      : String(err ?? 'Lỗi không xác định khi ghi file nền');
    console.warn('[FileQueue] Cảnh báo lỗi ghi file nền:', message);
  });
  return promise;
}

async function _processFileQueue(filePath, q) {
  q.isWriting = true;

  while (true) {
    q.hasPending = false;
    const currentResolvers = q.resolvers;
    q.resolvers = [];

    // Đối với DOCS_FILE, luôn lấy trực tiếp _docsCache mới nhất trong RAM để tránh Lost Update
    let dataToSave;
    if (path.resolve(filePath) === path.resolve(DOCS_FILE)) {
      dataToSave = _docsCache || [];
    } else {
      dataToSave = q.pendingData;
    }

    let success = false;
    let writeErr = null;

    try {
      await _writeJsonAsyncWithRetry(filePath, dataToSave);
      success = true;
    } catch (err) {
      writeErr = (err instanceof Error) ? err : new Error((err && typeof err === 'object' && typeof err.message === 'string') ? err.message : String(err));
      console.error(`[DataStore] Lỗi khi ghi đĩa file ${path.basename(filePath)}:`, writeErr.message);
    }

    for (const r of currentResolvers) {
      try {
        if (success) {
          r.resolve(true);
        } else {
          const finalErr = (writeErr instanceof Error)
            ? writeErr
            : new Error((writeErr && typeof writeErr === 'object' && typeof writeErr.message === 'string') ? writeErr.message : String(writeErr ?? 'Lỗi ghi đĩa không xác định'));
          r.reject(finalErr);
        }
      } catch (resolverErr) {
        const resErrMsg = (resolverErr && typeof resolverErr === 'object' && typeof resolverErr.message === 'string') ? resolverErr.message : String(resolverErr);
        console.warn('[dataStore] Lỗi resolve promise:', resErrMsg);
      }
    }

    // Nếu trong lúc ghi vừa rồi có yêu cầu lưu mới đến, tiếp tục vòng lặp ghi đợt tiếp theo
    if (q.hasPending) {
      continue;
    } else {
      break;
    }
  }

  q.isWriting = false;
}

async function waitForPendingWrites(filePath = DOCS_FILE) {
  const normalizedPath = path.resolve(filePath);
  const q = _fileQueues.get(normalizedPath);
  if (!q || (!q.isWriting && !q.hasPending)) {
    return true;
  }
  return new Promise(resolve => {
    q.resolvers.push({ resolve, reject: resolve });
  });
}

function saveJsonSafe(filePath, data) {
  return _queueFileSave(filePath, data);
}

function saveJsonSafeSync(filePath, data) {
  if (!filePath || typeof filePath !== 'string') {
    throw new TypeError('[dataStore saveJsonSafeSync] filePath bắt buộc phải là một chuỗi ký tự hợp lệ.');
  }
  let content;
  try {
    content = JSON.stringify(data, null, 2);
  } catch (err) {
    throw new TypeError(`[dataStore saveJsonSafeSync] Không thể serialize dữ liệu JSON cho [${filePath}]: ${err.message}`);
  }

  const tempPath = `${filePath}.${process.pid}.${Date.now()}.${crypto.randomBytes(8).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(tempPath, content, 'utf8');
    try {
      fs.renameSync(tempPath, filePath);
    } catch (renameErr) {
      if (process.platform === 'win32' && (renameErr.code === 'EPERM' || renameErr.code === 'EEXIST' || renameErr.code === 'EBUSY')) {
        fs.copyFileSync(tempPath, filePath);
        try { fs.unlinkSync(tempPath); } catch (uErr) { console.warn('[dataStore saveJsonSafeSync] Dọn tệp tạm thất bại:', uErr.message); }
      } else {
        throw renameErr;
      }
    }
  } catch (err) {
    if (fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch (uErr) { console.warn('[dataStore saveJsonSafeSync] Dọn tệp tạm thất bại:', uErr.message); }
    }
    throw new Error(`[dataStore saveJsonSafeSync] Giao dịch ghi file thất bại cho [${filePath}]: ${err.message}`);
  }
}

function saveUsers(users) {
  const usersToSave = Array.isArray(users)
    ? users.filter(u => u && typeof u === 'object')
    : (_usersCache ? _usersCache.filter(u => u && typeof u === 'object') : []);
  saveJsonSafeSync(USERS_FILE, usersToSave);
  _usersCache = usersToSave;
  return true;
}

function getUserById(id, forceReload = false) {
  if (!id || typeof id !== 'string') return null;
  const matchId = u => Boolean(u && typeof u === 'object' && u.id === id);
  if (forceReload) return getUsers(true).find(matchId) || null;
  let u = getUsers().find(matchId);
  if (!u) u = getUsers(true).find(matchId);
  return u || null;
}

function getUserByUsername(username, forceReload = false) {
  if (!username || typeof username !== 'string' || !username.trim()) return null;
  const lower = username.toLowerCase().trim();
  const matchUsername = u => Boolean(u && typeof u === 'object' && typeof u.username === 'string' && u.username.toLowerCase().trim() === lower);
  if (forceReload) return getUsers(true).find(matchUsername) || null;
  let u = getUsers().find(matchUsername);
  if (!u) u = getUsers(true).find(matchUsername);
  return u || null;
}

// =================== QUẢN LÝ TỔ CHUYÊN MÔN (DEPARTMENTS) ===================
let _deptsCache = null;

function getDepartments(forceReload = false) {
  if (forceReload || !_deptsCache) {
    _deptsCache = readJsonSafe(DEPTS_FILE, []);
  }
  return _deptsCache;
}

function saveDepartments(depts) {
  if (Array.isArray(depts)) {
    _deptsCache = depts.filter(d => d && typeof d === 'object');
  }
  return saveJsonSafe(DEPTS_FILE, _deptsCache || []);
}

function getDepartmentById(id) {
  if (!id || typeof id !== 'string') return null;
  return getDepartments().find(d => d && typeof d === 'object' && d.id === id) || null;
}

function createDepartment(deptData) {
  if (!deptData || typeof deptData !== 'object') {
    throw new TypeError('[dataStore createDepartment] Dữ liệu tổ chuyên môn không hợp lệ.');
  }
  const depts = getDepartments();
  const name = typeof deptData.name === 'string' ? deptData.name.trim() : '';
  if (!name) throw new Error('Tên tổ chuyên môn không được để trống!');
  const lowerName = name.toLowerCase();
  if (depts.some(d => d && typeof d.name === 'string' && d.name.trim().toLowerCase() === lowerName)) {
    throw new Error(`Tổ chuyên môn "${name}" đã tồn tại!`);
  }
  let codeRaw = typeof deptData.code === 'string' ? deptData.code.trim() : '';
  let idSuffix = codeRaw ? codeRaw.toLowerCase().replace(/[^a-z0-9_]/g, '_') : '';
  if (!idSuffix || idSuffix === '_') idSuffix = crypto.randomBytes(4).toString('hex');
  let id = 'dept_' + idSuffix;
  if (depts.some(d => d && d.id === id)) {
    id = 'dept_' + idSuffix + '_' + crypto.randomBytes(3).toString('hex');
  }
  const newDept = {
    id,
    name,
    code: codeRaw ? codeRaw.toUpperCase() : name.toUpperCase().slice(0, 8),
    description: typeof deptData.description === 'string' ? deptData.description.trim() : '',
    leaderId: (typeof deptData.leaderId === 'string' && deptData.leaderId.trim()) ? deptData.leaderId.trim() : null,
    createdAt: new Date().toISOString()
  };
  depts.push(newDept);
  saveDepartments(depts);
  return newDept;
}

function updateDepartment(id, updates) {
  if (!id || typeof id !== 'string') {
    throw new TypeError('[dataStore updateDepartment] id tổ chuyên môn không hợp lệ.');
  }
  if (!updates || typeof updates !== 'object') {
    throw new TypeError('[dataStore updateDepartment] updates không hợp lệ.');
  }
  const depts = getDepartments();
  const index = depts.findIndex(d => d && typeof d === 'object' && d.id === id);
  if (index === -1) throw new Error('Không tìm thấy tổ chuyên môn!');

  if (updates.name !== undefined) {
    if (typeof updates.name !== 'string' || !updates.name.trim()) {
      throw new Error('Tên tổ chuyên môn không được để trống!');
    }
    const newName = updates.name.trim();
    const lowerName = newName.toLowerCase();
    if (depts.some((d, idx) => idx !== index && d && typeof d.name === 'string' && d.name.trim().toLowerCase() === lowerName)) {
      throw new Error(`Tổ chuyên môn "${newName}" đã tồn tại!`);
    }
    depts[index].name = newName;
  }
  if (updates.code !== undefined) {
    if (typeof updates.code === 'string' && updates.code.trim()) {
      depts[index].code = updates.code.trim().toUpperCase();
    }
  }
  if (updates.description !== undefined) {
    depts[index].description = typeof updates.description === 'string' ? updates.description.trim() : '';
  }
  if (updates.leaderId !== undefined) {
    depts[index].leaderId = (typeof updates.leaderId === 'string' && updates.leaderId.trim()) ? updates.leaderId.trim() : null;
  }
  const saveRes = saveDepartments(depts);
  if (!saveRes) {
    throw new Error('Không thể lưu cập nhật tổ chuyên môn vào đĩa!');
  }
  return depts[index];
}

function deleteDepartment(id) {
  if (!id || typeof id !== 'string') return false;
  if (id === 'dept_bgh') throw new Error('Không thể xóa Ban Giám hiệu!');
  let depts = getDepartments();
  const initialLen = depts.length;
  depts = depts.filter(d => d && typeof d === 'object' && d.id !== id);
  if (depts.length !== initialLen) {
    const saveRes = saveDepartments(depts);
    if (!saveRes) {
      throw new Error('Không thể lưu xóa tổ chuyên môn vào đĩa!');
    }
    return true;
  }
  return false;
}

// =================== QUẢN LÝ THÔNG BÁO WEB PUSH (PWA) ===================
let _subsCache = null;

function getSubscriptions(forceReload = false) {
  if (forceReload || !Array.isArray(_subsCache)) {
    const raw = readJsonSafe(SUBS_FILE, []);
    _subsCache = Array.isArray(raw) ? raw.filter(s => s && typeof s === 'object') : [];
  }
  return _subsCache.map(s => (s && typeof s === 'object' ? { ...s } : s));
}

function isValidWebPushSubscription(s) {
  if (!s || typeof s !== 'object') return false;
  const sub = (s.subscription && typeof s.subscription === 'object') ? s.subscription : s;
  if (!sub || typeof sub !== 'object') return false;
  if (typeof sub.endpoint !== 'string' || !sub.endpoint.trim()) return false;
  let endpointUrl;
  try {
    endpointUrl = new URL(sub.endpoint.trim());
  } catch {
    return false;
  }
  if (endpointUrl.protocol !== 'https:') return false;
  if (!sub.keys || typeof sub.keys !== 'object') return false;
  return typeof sub.keys.p256dh === 'string' && sub.keys.p256dh.trim().length > 0 &&
         typeof sub.keys.auth === 'string' && sub.keys.auth.trim().length > 0;
}

function saveSubscriptions(subs) {
  if (!Array.isArray(subs)) return false;
  const normalized = subs.filter(s => isValidWebPushSubscription(s));
  const res = saveJsonSafe(SUBS_FILE, normalized);
  if (!res) {
    return false;
  }
  _subsCache = normalized;
  return res;
}

function saveSubscription(userId, subscription) {
  if (typeof userId !== 'string' || !userId.trim() || !isValidWebPushSubscription(subscription)) {
    return false;
  }
  const normalizedUserId = userId.trim();
  const subs = getSubscriptions();
  const subEndpoint = subscription.endpoint || (subscription.subscription && subscription.subscription.endpoint);
  const existingIdx = subs.findIndex(s => s && (s.endpoint === subEndpoint || (s.subscription && s.subscription.endpoint === subEndpoint)));
  if (existingIdx !== -1) {
    subs[existingIdx] = {
      ...subs[existingIdx],
      userId: normalizedUserId,
      subscription,
      endpoint: subEndpoint,
      updatedAt: new Date().toISOString()
    };
  } else {
    subs.push({
      userId: normalizedUserId,
      subscription,
      endpoint: subEndpoint,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString()
    });
  }
  return saveSubscriptions(subs);
}

function getSubscriptionsForUser(userId) {
  if (typeof userId !== 'string' || !userId.trim()) return [];
  const normalizedUserId = userId.trim();
  return getSubscriptions().filter(s => s && s.userId === normalizedUserId).map(s => s.subscription).filter(Boolean);
}

// =================== QUẢN LÝ TÀI KHOẢN GIÁO VIÊN & BGH ===================
function createUser(userData) {
  if (!userData || typeof userData !== 'object' ||
      typeof userData.username !== 'string' ||
      !userData.username.trim()) {
    throw new Error('Dữ liệu người dùng không hợp lệ');
  }
  const users = getUsers();
  const username = userData.username.trim().toLowerCase();
  
  if (users.some(u => u && typeof u.username === 'string' && u.username.trim().toLowerCase() === username)) {
    throw new Error(`Tên đăng nhập "${username}" đã tồn tại trên hệ thống!`);
  }

  const validRoles = ['ADMIN', 'BGH', 'HEAD_DEPT', 'TEACHER'];
  const role = (typeof userData.role === 'string' && validRoles.includes(userData.role.trim()))
    ? userData.role.trim()
    : 'TEACHER';

  const validStatuses = ['ACTIVE', 'LOCKED'];
  const status = (typeof userData.status === 'string' && validStatuses.includes(userData.status.trim()))
    ? userData.status.trim()
    : 'ACTIVE';

  const validSignTypes = ['VGCA', 'USB_TOKEN'];
  const defaultSignType = (role === 'BGH' || role === 'ADMIN') ? 'USB_TOKEN' : 'VGCA';
  const signType = (typeof userData.signType === 'string' && validSignTypes.includes(userData.signType.trim()))
    ? userData.signType.trim()
    : defaultSignType;

  const roleTitleMap = {
    'ADMIN': 'Quản trị viên hệ thống',
    'BGH': 'Ban Giám hiệu nhà trường',
    'HEAD_DEPT': `Tổ trưởng ${(typeof userData.department === 'string' && userData.department.trim()) ? userData.department.trim() : ''}`,
    'TEACHER': `Giáo viên ${(typeof userData.department === 'string' && userData.department.trim()) ? userData.department.trim() : ''}`
  };

  let userId = (typeof userData.id === 'string' && userData.id.trim()) ? userData.id.trim() : null;
  if (userId) {
    if (users.some(u => u && u.id === userId)) {
      throw new Error(`Mã định danh người dùng "${userId}" đã tồn tại trên hệ thống!`);
    }
  } else {
    userId = 'user_' + crypto.randomUUID();
  }

  const rawPassword = (typeof userData.password === 'string' && userData.password.length > 0)
    ? userData.password
    : crypto.randomBytes(16).toString('hex');
  const hashedPassword = hashPasswordSync(rawPassword);

  const newUser = {
    id: userId,
    username: username,
    password: hashedPassword,
    name: (typeof userData.name === 'string' && userData.name.trim()) ? userData.name.trim() : username,
    role: role,
    roleTitle: (typeof userData.roleTitle === 'string' && userData.roleTitle.trim())
      ? userData.roleTitle.trim()
      : (roleTitleMap[role] || 'Giáo viên'),
    department: (typeof userData.department === 'string' && userData.department.trim()) ? userData.department.trim() : 'Tổ Toán - Tin',
    departmentId: (typeof userData.departmentId === 'string' && userData.departmentId.trim()) ? userData.departmentId.trim() : null,
    signType: signType,
    status: status,
    email: (typeof userData.email === 'string' && userData.email.trim()) ? userData.email.trim() : `${username}@thcschuvanan.edu.vn`,
    officialEmail: (typeof userData.officialEmail === 'string' && userData.officialEmail.trim())
      ? userData.officialEmail.trim()
      : ((typeof userData.email === 'string' && userData.email.trim()) ? userData.email.trim() : ''),
    cccd: (typeof userData.cccd === 'string' && userData.cccd.trim()) ? userData.cccd.trim() : '',
    certSerial: (typeof userData.certSerial === 'string' && userData.certSerial.trim()) ? userData.certSerial.trim() : '',
    school: 'TRƯỜNG TRUNG HỌC CƠ SỞ CHU VĂN AN',
    phone: (typeof userData.phone === 'string' && userData.phone.trim()) ? userData.phone.trim() : '',
    pinCode: (() => {
      let rawPin;
      if (userData.pinCode !== undefined && userData.pinCode !== null && String(userData.pinCode).trim()) {
        const raw = String(userData.pinCode).trim();
        rawPin = (/^\d+$/.test(raw) && raw.length < 4) ? raw.padStart(4, '0') : raw;
      } else {
        rawPin = String(crypto.randomInt(1000, 10000));
      }
      return hashPasswordSync(rawPin);
    })(),
    canUploadWord: userData.canUploadWord !== undefined ? Boolean(userData.canUploadWord) : true,
    canStampSeal: (userData.role === 'ADMIN') ? false : (userData.canStampSeal !== undefined ? Boolean(userData.canStampSeal) : false),
    signatureImage: null,
    createdAt: new Date().toISOString()
  };

  users.push(newUser);
  saveUsers(users);
  return newUser;
}

function updateUser(id, updates) {
  if (!id || typeof id !== 'string' || !id.trim()) {
    throw new Error('ID người dùng không hợp lệ');
  }
  if (!updates || typeof updates !== 'object') {
    throw new Error('Dữ liệu cập nhật người dùng không hợp lệ');
  }
  const cleanId = id.trim();
  const users = getUsers(true);

  const index = users.findIndex(u =>
    u && (u.id === cleanId || (typeof u.username === 'string' && u.username.toLowerCase() === cleanId.toLowerCase()))
  );

  if (index === -1) {
    throw new Error(`Không tìm thấy người dùng [${cleanId}] để cập nhật!`);
  }

  // Không cho đổi id hoặc hạ quyền/khóa admin gốc
  if (users[index].id === 'admin') {
    if (updates.role && updates.role !== 'ADMIN') {
      throw new Error('Không thể hạ quyền của tài khoản Quản trị viên gốc!');
    }
    if (updates.status && updates.status === 'LOCKED') {
      throw new Error('Không thể khóa tài khoản Quản trị viên gốc!');
    }
  }

  const roleTitleMap = {
    'ADMIN': 'Quản trị viên hệ thống',
    'BGH': 'Ban Giám hiệu nhà trường',
    'HEAD_DEPT': `Tổ trưởng ${(typeof updates.department === 'string' ? updates.department.trim() : (users[index].department || ''))}`,
    'TEACHER': `Giáo viên ${(typeof updates.department === 'string' ? updates.department.trim() : (users[index].department || ''))}`
  };

  const validRoles = ['ADMIN', 'BGH', 'HEAD_DEPT', 'TEACHER'];
  const validStatuses = ['ACTIVE', 'LOCKED'];
  const validSignTypes = ['VGCA', 'USB_TOKEN'];

  if (typeof updates.name === 'string') users[index].name = updates.name.trim();
  if (typeof updates.role === 'string' && validRoles.includes(updates.role.trim())) {
    users[index].role = updates.role.trim();
    users[index].roleTitle = roleTitleMap[users[index].role];
    if (users[index].role === 'ADMIN') {
      users[index].canStampSeal = false;
    }
  }
  if (typeof updates.department === 'string') {
    users[index].department = updates.department.trim();
    if (users[index].role === 'HEAD_DEPT' || users[index].role === 'TEACHER') {
      users[index].roleTitle = roleTitleMap[users[index].role];
    }
  }
  if (updates.departmentId !== undefined) {
    users[index].departmentId = (typeof updates.departmentId === 'string') ? updates.departmentId.trim() : updates.departmentId;
  }
  if (typeof updates.signType === 'string' && validSignTypes.includes(updates.signType.trim())) {
    users[index].signType = updates.signType.trim();
  }
  if (typeof updates.status === 'string' && validStatuses.includes(updates.status.trim())) {
    users[index].status = updates.status.trim();
  }
  if (typeof updates.email === 'string') users[index].email = updates.email.trim();
  if (typeof updates.officialEmail === 'string') users[index].officialEmail = updates.officialEmail.trim();
  if (typeof updates.cccd === 'string') users[index].cccd = updates.cccd.trim();
  const parseSafeBoolean = (val) => {
    if (val === true || val === false) return val;
    if (val === 'true' || val === 1 || val === '1') return true;
    if (val === 'false' || val === 0 || val === '0') return false;
    return undefined;
  };

  if (updates.canUploadWord !== undefined) {
    const b = parseSafeBoolean(updates.canUploadWord);
    if (b !== undefined) users[index].canUploadWord = b;
  }
  if (updates.canStampSeal !== undefined) {
    const b = parseSafeBoolean(updates.canStampSeal);
    if (b !== undefined) users[index].canStampSeal = (users[index].role === 'ADMIN' ? false : b);
  }
  if (typeof updates.certSerial === 'string') users[index].certSerial = updates.certSerial.trim();
  if (typeof updates.phone === 'string') users[index].phone = updates.phone.trim();
  if (updates.pinCode !== undefined || updates.zaloPin !== undefined) {
    const rawP = updates.pinCode !== undefined ? String(updates.pinCode).trim() : String(updates.zaloPin).trim();
    let cleanPin = null;
    if (rawP.length >= 4 && rawP.length <= 16 && /^[a-zA-Z0-9@#$_\-]+$/.test(rawP)) {
      cleanPin = rawP;
    } else if (/^\d{1,4}$/.test(rawP)) {
      cleanPin = rawP.padStart(4, '0');
    }
    if (cleanPin) {
      users[index].pinCode = hashPasswordSync(cleanPin);
    }
  }
  if (updates.signatureImage !== undefined) {
    if (updates.signatureImage === null || updates.signatureImage === '') {
      users[index].signatureImage = null;
    } else if (typeof updates.signatureImage === 'string' && updates.signatureImage.length <= 3 * 1024 * 1024) {
      const trimmedImg = updates.signatureImage.trim();
      if (/^data:image\/(png|jpeg|jpg);base64,[A-Za-z0-9+/=]+$/.test(trimmedImg)) {
        users[index].signatureImage = trimmedImg;
      }
    }
  }
  if (updates.vgcaAuth !== undefined) {
    if (updates.vgcaAuth === null || updates.vgcaAuth === false) {
      users[index].vgcaAuth = null;
    } else if (typeof updates.vgcaAuth === 'boolean') {
      users[index].vgcaAuth = updates.vgcaAuth;
    } else if (updates.vgcaAuth && typeof updates.vgcaAuth === 'object' && !Array.isArray(updates.vgcaAuth)) {
      users[index].vgcaAuth = {
        account: typeof updates.vgcaAuth.account === 'string' ? updates.vgcaAuth.account.slice(0, 256) : '',
        signerName: typeof updates.vgcaAuth.signerName === 'string' ? updates.vgcaAuth.signerName.slice(0, 256) : '',
        serial: typeof updates.vgcaAuth.serial === 'string' ? updates.vgcaAuth.serial.slice(0, 128) : '',
        subject: typeof updates.vgcaAuth.subject === 'string' ? updates.vgcaAuth.subject.slice(0, 256) : '',
        expiresAt: (typeof updates.vgcaAuth.expiresAt === 'number' || typeof updates.vgcaAuth.expiresAt === 'string') ? updates.vgcaAuth.expiresAt : null,
        lastActiveAt: typeof updates.vgcaAuth.lastActiveAt === 'number' ? updates.vgcaAuth.lastActiveAt : Date.now(),
        verifiedAt: new Date().toISOString()
      };
    }
  }

  const saveRes = saveUsers(users);
  if (!saveRes) throw new Error('Không thể lưu thông tin người dùng vào đĩa!');
  return users[index];
}

function toggleUserLock(id) {
  if (!id || typeof id !== 'string' || !id.trim()) throw new Error('ID người dùng không hợp lệ');
  const normalizedId = id.trim().toLowerCase();
  if (normalizedId === 'admin') throw new Error('Không thể khóa tài khoản Quản trị viên gốc!');
  const users = getUsers(true);
  const cleanId = id.trim();
  const user = users.find(u => u && (u.id === cleanId || (typeof u.username === 'string' && u.username.toLowerCase() === normalizedId)));
  if (!user) throw new Error('Không tìm thấy người dùng!');
  if (user.id === 'admin' || (typeof user.username === 'string' && user.username.toLowerCase() === 'admin')) {
    throw new Error('Không thể khóa tài khoản Quản trị viên gốc!');
  }
  if (user.status !== 'ACTIVE' && user.status !== 'LOCKED') {
    throw new Error(`Trạng thái người dùng [${user.status}] không hợp lệ để thực hiện thao tác khóa/mở khóa!`);
  }
  user.status = (user.status === 'LOCKED') ? 'ACTIVE' : 'LOCKED';
  const saveRes = saveUsers(users);
  if (!saveRes) throw new Error('Không thể lưu trạng thái người dùng vào đĩa!');
  return user;
}

function resetPassword(id, newPassword) {
  if (!id || typeof id !== 'string' || !id.trim()) throw new Error('ID người dùng không hợp lệ');
  const cleanId = id.trim();
  const normalizedId = cleanId.toLowerCase();
  if (normalizedId === 'admin') throw new Error('Không thể đặt lại mật khẩu cho tài khoản Quản trị viên gốc!');
  const users = getUsers(true);
  const user = users.find(u => u && (u.id === cleanId || (typeof u.username === 'string' && u.username.toLowerCase() === normalizedId)));
  if (!user) throw new Error('Không tìm thấy người dùng!');
  if (user.id === 'admin' || (typeof user.username === 'string' && user.username.toLowerCase() === 'admin')) {
    throw new Error('Không thể đặt lại mật khẩu cho tài khoản Quản trị viên gốc!');
  }
  let rawPassword;
  if (newPassword !== undefined && newPassword !== null) {
    if (typeof newPassword !== 'string' || newPassword.length < 8 || !newPassword.trim()) {
      throw new Error('Mật khẩu mới không hợp lệ! Bắt buộc là chuỗi có độ dài tối thiểu 8 ký tự và không được chỉ chứa khoảng trắng.');
    }
    rawPassword = newPassword;
  } else {
    rawPassword = crypto.randomBytes(16).toString('hex');
  }
  user.password = hashPasswordSync(rawPassword);
  const saveRes = saveUsers(users);
  if (!saveRes) throw new Error('Không thể lưu mật khẩu mới vào đĩa!');
  return true;
}

function deleteUser(id) {
  if (!id || typeof id !== 'string' || !id.trim()) return false;
  const cleanId = id.trim();
  const normalizedId = cleanId.toLowerCase();
  if (normalizedId === 'admin') throw new Error('Không thể xóa tài khoản Quản trị viên gốc!');
  let users = getUsers(true);
  const targetUser = users.find(u => u && (u.id === cleanId || (typeof u.username === 'string' && u.username.toLowerCase() === normalizedId)));
  if (targetUser && (targetUser.id === 'admin' || (typeof targetUser.username === 'string' && targetUser.username.toLowerCase() === 'admin'))) {
    throw new Error('Không thể xóa tài khoản Quản trị viên gốc!');
  }
  const initialLen = users.length;
  users = users.filter(u => u && u.id !== cleanId && (typeof u.username !== 'string' || u.username.toLowerCase() !== normalizedId));
  if (users.length !== initialLen) {
    const saveRes = saveUsers(users);
    if (!saveRes) throw new Error('Không thể lưu danh sách người dùng sau khi xóa!');
    return true;
  }
  return false;
}

function getSigners() {
  const users = getUsers();
  if (!Array.isArray(users)) return [];
  return users
    .filter(u => u && typeof u === 'object' && u.status !== 'LOCKED')
    .map(u => ({
      id: u.id,
      name: u.name,
      role: u.role,
      roleTitle: u.roleTitle,
      department: u.department,
      email: u.email
    }));
}

// =================== QUẢN LÝ HỒ SƠ GIÁO ÁN & TỐI ƯU HÓA LƯU TRỮ ===================

/**
 * Kiểm tra hồ sơ đã được lưu trữ / ẩn khỏi bảng chính hay chưa
 * Hồ sơ được coi là ĐÃ LƯU TRỮ (Archived) nếu:
 * 1. Trạng thái hồ sơ đã hoàn tất/lưu trữ (isArchived === true hoặc status === 'ARCHIVED')
 * 2. ĐÃ ĐƯỢC SAO LƯU THÀNH CÔNG lên ít nhất một dịch vụ đám mây an toàn (Google Drive hoặc OneDrive):
 *    - Đã lưu Google Drive (driveInfo.fileId hợp lệ hoặc googleDriveUrl hợp chuẩn), HOẶC
 *    - Đã lưu OneDrive trường (oneDriveSynced === true hoặc oneDriveUploaded === true với trạng thái thành công)
 */
function isValidGoogleDriveUrl(urlStr) {
  if (typeof urlStr !== 'string' || !urlStr.trim()) return false;
  try {
    const u = new URL(urlStr.trim());
    if (u.protocol !== 'https:') return false;
    const host = u.hostname.toLowerCase();
    if (host !== 'drive.google.com' && host !== 'docs.google.com') return false;
    return u.pathname.includes('/d/') || u.pathname.startsWith('/file/') || u.searchParams.has('id');
  } catch (_) {
    return false;
  }
}

function isValidDriveFileId(id) {
  if (typeof id !== 'string') return false;
  const clean = id.trim();
  return /^[A-Za-z0-9_-]{10,}$/.test(clean) &&
    !['undefined', 'null', 'failed'].includes(clean.toLowerCase());
}

function isDocCloudSaved(d) {
  if (!d || typeof d !== 'object') return false;
  const hasOneDrive =
    d.oneDriveSynced === true ||
    (d.oneDriveUploaded === true &&
      ['completed', 'SYNCED', 'success', 'SUCCESS'].includes(d.oneDriveStatus));
  const hasDriveId = Boolean(d.driveInfo && typeof d.driveInfo === 'object' && isValidDriveFileId(d.driveInfo.fileId));
  const hasDriveUrl = isValidGoogleDriveUrl(d.googleDriveUrl);
  return hasOneDrive || hasDriveId || hasDriveUrl;
}

function isDocArchived(d) {
  if (!d || typeof d !== 'object') return false;
  const hasCloud = isDocCloudSaved(d);
  return Boolean((d.isArchived === true || d.status === 'ARCHIVED') && hasCloud);
}

let _hasRunSanitization = false;

/**
 * Cơ chế Đồng bộ & Dọn dẹp Dữ liệu:
 * - CHỈ lưu trữ và ẩn các file khi đã thực sự lưu thành công vào OneDrive / Drive
 * - Phục hồi các file chưa lưu OneDrive để hiển thị trên bảng làm việc chính
 * - Dọn sạch các trường nhị phân nặng (fileBase64, signedPdfBase64) khỏi DB để máy chủ siêu nhẹ
 */
function sanitizeDocuments(docs) {
  if (!Array.isArray(docs)) return [];
  let changed = false;
  docs.forEach(doc => {
    if (!doc) return;

    const hasCloudSaved = isDocCloudSaved(doc);

    // 1. Nếu ĐÃ lưu OneDrive/Drive thành công và hồ sơ đã hoàn thành -> đánh dấu isArchived = true
    if (hasCloudSaved && (doc.status === 'COMPLETED' || doc.status === 'APPROVED' || doc.status === 'ARCHIVED' || doc.isCompleted === true)) {
      if (!doc.isArchived || doc.status !== 'ARCHIVED') {
        doc.isArchived = true;
        doc.status = 'ARCHIVED';
        if (!doc.archivedAt) doc.archivedAt = doc.createdAt || new Date().toISOString().replace('T', ' ').substring(0, 19);
        changed = true;
      }
    } else if (!hasCloudSaved) {
      // 2. Nếu CHƯA lưu OneDrive/Drive -> TUYỆT ĐỐI KHÔNG ẨN, giữ nguyên trên bảng chính!
      if (doc.isArchived === true || doc.status === 'ARCHIVED') {
        doc.isArchived = false;
        doc.status = 'COMPLETED';
        delete doc.archivedAt;
        changed = true;
      }
    }

    // 2. Chuẩn hóa category nếu thiếu
    if (!doc.category) {
      const title = typeof doc.title === 'string' ? doc.title : '';
      doc.category = (title.includes('Báo cáo') || title.includes('Kế hoạch giáo dục')) ? 'REPORT' : 'PERSONAL';
      changed = true;
    }

    // 3. Giải phóng bộ nhớ máy chủ triệt để: Xóa bỏ chuỗi nhị phân base64 nặng khỏi JSON/RAM
    if (doc.fileBase64) {
      delete doc.fileBase64;
      changed = true;
    }
    if (doc.signedPdfBase64) {
      delete doc.signedPdfBase64;
      changed = true;
    }
  });

  if (changed) {
    const saveRes = saveDocuments(docs);
    if (!saveRes) {
      throw new Error('Không thể lưu cập nhật hồ sơ vào đĩa!');
    }
  }
  return docs;
}

let _docsCache = null;

function getDocuments(forceReload = false) {
  const hasPending = _hasPendingWrites(DOCS_FILE);
  if ((forceReload && !hasPending) || !_docsCache) {
    const docs = readJsonSafe(DOCS_FILE, []);
    _docsCache = sanitizeDocuments(Array.isArray(docs) ? docs : []);
    _hasRunSanitization = true;
  }
  return _docsCache;
}

function saveDocuments(docs) {
  if (Array.isArray(docs)) {
    _docsCache = docs;
  }
  return saveJsonSafe(DOCS_FILE, _docsCache);
}

/**
 * Đảm bảo tất cả các cập nhật hồ sơ đang trong hàng đợi được ghi hoàn tất vào đĩa
 */
async function flushDocuments() {
  if (_docsCache) {
    await saveDocuments(_docsCache);
  }
  await waitForPendingWrites(DOCS_FILE);
  return true;
}

function getDocumentById(id, forceReload = false) {
  if (!id || typeof id !== 'string') return null;
  const cleanId = id.trim();
  if (forceReload) {
    return getDocuments(true).find(d => d && d.id === cleanId) || null;
  }
  let doc = getDocuments().find(d => d && d.id === cleanId);
  if (!doc) {
    doc = getDocuments(true).find(d => d && d.id === cleanId);
  }
  return doc || null;
}

function normalizeFilePath(p) {
  if (!p || typeof p !== 'string' || !p.trim()) return null;
  const clean = p.trim().replace(/\\/g, '/');
  const match = clean.match(/(?:^|\/)(uploads\/documents\/[^/]+)$/i) || clean.match(/(?:^|\/)(uploads\/[^/]+)$/i);
  if (match) {
    const rel = match[1];
    if (!rel.includes('..')) {
      return rel;
    }
  }
  const base = path.basename(clean);
  if (base && !base.includes('..') && base !== '.' && !base.startsWith('/')) {
    return `uploads/documents/${base}`;
  }
  return null;
}

function isPathUnderDir(targetPath, baseDir) {
  try {
    if (!fs.existsSync(targetPath)) return false;
    const realTarget = fs.realpathSync(targetPath);
    const realBase = fs.realpathSync(baseDir);
    const rel = path.relative(realBase, realTarget);
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

function resolveFilePath(filePath) {
  if (!filePath || typeof filePath !== 'string' || !filePath.trim()) return null;
  const clean = filePath.trim();
  const allowedDir = path.resolve(__dirname, 'uploads');
  if (!fs.existsSync(allowedDir)) return null;

  // 1. Kiểm tra trực tiếp
  const direct = path.resolve(clean);
  if (isPathUnderDir(direct, allowedDir)) {
    return direct;
  }

  // 2. Kiểm tra theo đường dẫn chuẩn hóa
  const norm = normalizeFilePath(clean);
  if (norm) {
    const local = path.resolve(__dirname, norm);
    if (isPathUnderDir(local, allowedDir)) {
      return local;
    }
  }

  // 3. Fallback theo basename trong uploads/documents
  const base = path.basename(clean);
  if (base && !base.includes('..')) {
    const inDocs = path.resolve(__dirname, 'uploads', 'documents', base);
    if (isPathUnderDir(inDocs, allowedDir)) {
      return inDocs;
    }
  }
  return null;
}

function generateTrackingId(deptName, docType = 'REPORT') {
  const safeDept = (typeof deptName === 'string' && deptName.trim()) ? deptName.trim() : 'CVA';
  const clean = safeDept.replace(/Tổ\s*/gi, '').trim();
  const map = {
    'Toán - Tin': 'TOAN-TIN',
    'Toán': 'TOAN',
    'Tin': 'TIN',
    'Khoa học Tự nhiên': 'KHTN',
    'Khoa học Xã hội': 'KHXH',
    'Ngữ văn': 'VAN',
    'Tiếng Anh': 'ANH',
    'Nghệ thuật': 'NT',
    'GDTC': 'GDTC'
  };
  const deptCode = map[clean] || clean.replace(/[^a-zA-Z0-9]/g, '').toUpperCase().slice(0, 8) || 'CVA';
  const prefix = (docType === 'REPORT' || docType === 'BC') ? 'BC' : 'KHBD';
  const year = new Date().getFullYear();
  const rand = Math.floor(100000 + Math.random() * 900000);
  return `${prefix}-${year}-${deptCode}-${rand}`;
}

function createDocument(docData, currentUser = {}) {
  if (!docData || typeof docData !== 'object') {
    throw new Error('Dữ liệu hồ sơ (docData) bắt buộc phải là một đối tượng hợp lệ.');
  }
  const user = (currentUser && typeof currentUser === 'object') ? currentUser : {};
  const docs = getDocuments();
  const hasUser = Boolean(user.id || user.username || user.name);

  const deptName = (typeof user.department === 'string' && user.department.trim())
    ? user.department.trim()
    : ((typeof user.departmentName === 'string' && user.departmentName.trim())
      ? user.departmentName.trim()
      : (hasUser ? 'Tổ Toán - Tin' : ((typeof docData.creatorDept === 'string' && docData.creatorDept.trim()) ? docData.creatorDept.trim() : 'Tổ Toán - Tin')));

  const authorName = (typeof user.name === 'string' && user.name.trim())
    ? user.name.trim()
    : ((typeof user.fullName === 'string' && user.fullName.trim())
      ? user.fullName.trim()
      : (hasUser && typeof user.username === 'string' && user.username.trim()
        ? user.username.trim()
        : ((typeof docData.creatorName === 'string' && docData.creatorName.trim()) ? docData.creatorName.trim() : 'Giáo viên')));

  const authorId = (typeof user.id === 'string' && user.id.trim())
    ? user.id.trim()
    : ((typeof user.username === 'string' && user.username.trim())
      ? user.username.trim()
      : (hasUser ? 'teacher' : ((typeof docData.creatorId === 'string' && docData.creatorId.trim()) ? docData.creatorId.trim() : 'teacher')));

  const authorUsername = (typeof user.username === 'string' && user.username.trim())
    ? user.username.trim()
    : authorId;

  const category = (typeof docData.category === 'string' && docData.category.trim())
    ? docData.category.trim()
    : 'PERSONAL';

  let newId;
  if (typeof docData.id === 'string' && docData.id.trim()) {
    const candidateId = docData.id.trim();
    if (docs.some(d => d && d.id === candidateId)) {
      throw new Error(`Mã hồ sơ [${candidateId}] đã tồn tại trên hệ thống!`);
    }
    newId = candidateId;
  } else {
    do {
      newId = generateTrackingId(deptName, category === 'REPORT' ? 'REPORT' : 'KHBD');
    } while (docs.some(d => d && d.id === newId));
  }

  const isPersonal = (category === 'PERSONAL');
  const validStatuses = ['PENDING_SIGN', 'PENDING_SEAL', 'WAITING_SIGNER_APPROVAL', 'WAITING_LEADER_APPROVAL', 'COMPLETED', 'ARCHIVED', 'REJECTED'];
  let defaultStatus;
  if (isPersonal) {
    defaultStatus = 'COMPLETED';
  } else if (typeof docData.status === 'string' && validStatuses.includes(docData.status.trim())) {
    const candidateStatus = docData.status.trim();
    if (candidateStatus === 'COMPLETED') {
      defaultStatus = (docData.isCompleted === true && Array.isArray(docData.signatures) && docData.signatures.length > 0)
        ? 'COMPLETED'
        : (docData.nextSignerId ? 'PENDING_SIGN' : 'WAITING_LEADER_APPROVAL');
    } else {
      defaultStatus = candidateStatus;
    }
  } else {
    defaultStatus = docData.nextSignerId ? 'WAITING_SIGNER_APPROVAL' : 'WAITING_LEADER_APPROVAL';
  }

  const validSignerRoles = [
    'Tổ trưởng Chuyên môn',
    'Tổ trưởng chuyên môn',
    'Tổ trưởng',
    'Ban Giám hiệu',
    'Ban Giám hiệu nhà trường',
    'Hiệu trưởng',
    'Phó Hiệu trưởng',
    'Giáo viên',
    'Người duyệt tiếp theo',
    'ADMIN',
    'BGH',
    'HEAD_DEPT',
    'TEACHER'
  ];
  const isValidSignerRole = (r) =>
    typeof r === 'string' &&
    validSignerRoles.includes(r.trim());

  const hasValidNextSigner = Boolean(docData.nextSignerId && typeof docData.nextSignerId === 'string' && docData.nextSignerId.trim());
  const validatedNextRole = (hasValidNextSigner && isValidSignerRole(docData.nextSignerRole))
    ? docData.nextSignerRole.trim()
    : (hasValidNextSigner ? 'Tổ trưởng Chuyên môn' : null);

  const currentSignerRole = isPersonal ? null : (validatedNextRole || 'Tổ trưởng Chuyên môn');

  const newDoc = {
    id: newId,
    title: (typeof docData.title === 'string' && docData.title.trim()) ? docData.title.trim() : 'Hồ sơ giáo dục',
    category: category,
    author: authorName,
    authorId: authorId,
    authorUsername: authorUsername,
    creatorId: authorId,
    creatorName: authorName,
    creatorDept: deptName,
    assignedTo: docData.assignedTo || null,
    assignedToName: docData.assignedToName || null,
    currentSignerId: docData.currentSignerId || null,
    currentSignerName: docData.currentSignerName || null,
    department: deptName,
    grade: docData.grade || 'Khối 9',
    week: docData.week || 'Tuần 1',
    term: docData.term || 'Học kỳ I',
    createdAt: docData.createdAt || docData.createdDate || new Date().toISOString().replace('T', ' ').substring(0, 19),
    updatedAt: docData.updatedAt || new Date().toISOString(),
    status: defaultStatus,
    syncStatus: docData.syncStatus || null,
    currentSignerRole: currentSignerRole,
    nextSignerId: docData.nextSignerId || null,
    nextSignerName: docData.nextSignerName || null,
    nextSignerRole: validatedNextRole,
    isArchived: docData.isArchived || false,
    fileName: docData.fileName || 'GiaoAn_Chuan.pdf',
    fileType: docData.fileType || 'pdf', // 'pdf', 'docx', 'doc'
    filePath: normalizeFilePath(docData.filePath) || null,
    fileBase64: null,
    customContentHtml: (() => {
      if (typeof docData.customContentHtml !== 'string') return null;
      const raw = docData.customContentHtml.trim();
      if (!raw) return null;
      return raw.slice(0, 500000)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
    })(),
    realSignedPath: normalizeFilePath(docData.realSignedPath),
    signedPdfBase64: null,
    signPlacement: (typeof docData.signPlacement === 'string' && docData.signPlacement.trim()) ? docData.signPlacement.trim() : 'bottom-right',
    fileSize: (typeof docData.fileSize === 'string' && docData.fileSize.trim()) ? docData.fileSize.trim() : '1.5 MB',
    pages: (typeof docData.pages === 'number' && Number.isInteger(docData.pages) && docData.pages > 0) ? docData.pages : 10,
    copyType: (typeof docData.copyType === 'string' && docData.copyType.trim()) ? docData.copyType.trim() : null,
    copyText: (typeof docData.copyText === 'string' && docData.copyText.trim()) ? docData.copyText.trim() : null,
    copySignBannerBase64: (() => {
      if (typeof docData.copySignBannerBase64 !== 'string') return null;
      const banner = docData.copySignBannerBase64.trim();
      if (banner.length === 0 || banner.length > 2 * 1024 * 1024) return null;
      const dataUriMatch = banner.match(/^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=]+)$/);
      if (dataUriMatch) return banner;
      if (/^[A-Za-z0-9+/=]+$/.test(banner)) return banner;
      return null;
    })(),
    copySignBannerWidthPt: (typeof docData.copySignBannerWidthPt === 'number' && Number.isFinite(docData.copySignBannerWidthPt) && docData.copySignBannerWidthPt > 0 && docData.copySignBannerWidthPt <= 2000) ? docData.copySignBannerWidthPt : null,
    copySignBannerHeightPt: (typeof docData.copySignBannerHeightPt === 'number' && Number.isFinite(docData.copySignBannerHeightPt) && docData.copySignBannerHeightPt > 0 && docData.copySignBannerHeightPt <= 2000) ? docData.copySignBannerHeightPt : null,
    signatures: (Array.isArray(docData.signatures) ? docData.signatures.slice(0, 20) : [])
      .filter(s => s && typeof s === 'object')
      .map((s, idx) => ({
        step: (Number.isInteger(s.step) && s.step > 0 && s.step <= 20) ? s.step : (idx + 1),
        signerId: typeof s.signerId === 'string' ? s.signerId.trim().slice(0, 100) : null,
        signerName: typeof s.signerName === 'string' ? s.signerName.trim().slice(0, 200) : null,
        signerRole: typeof s.signerRole === 'string' ? s.signerRole.trim().slice(0, 100) : null,
        signedAt: (() => {
          if (typeof s.signedAt !== 'string') return null;
          const trimmed = s.signedAt.trim();
          const parsed = Date.parse(trimmed);
          return (!isNaN(parsed) && trimmed.length <= 50) ? new Date(parsed).toISOString() : null;
        })(),
        certSerial: typeof s.certSerial === 'string' ? s.certSerial.trim().slice(0, 100) : null,
        certIssuer: typeof s.certIssuer === 'string' ? s.certIssuer.trim().slice(0, 200) : null,
        note: typeof s.note === 'string' ? s.note.trim().slice(0, 500) : ''
      })),
    ...(() => {
      const normalizedSignType = (typeof docData.signType === 'string' && ['STANDARD', 'VGCA', 'USB_TOKEN', 'COPY'].includes(docData.signType.trim())) ? docData.signType.trim() : 'STANDARD';
      const isCopy = (docData.isCopySign === true || docData.isCopySign === 'true') || (normalizedSignType === 'COPY');
      const normalizedReportCategory = (typeof docData.reportCategory === 'string' && docData.reportCategory.trim()) ? docData.reportCategory.trim() : (docData.requiresSeal ? 'SCHOOL' : (category === 'REPORT' ? 'INTERNAL' : null));
      const normalizedCategoryType = (typeof docData.categoryType === 'string' && docData.categoryType.trim()) ? docData.categoryType.trim() : (normalizedReportCategory === 'SCHOOL' ? 'SCHOOL_REPORT' : (category === 'REPORT' ? 'INTERNAL_REPORT' : null));
      const isInternal = (normalizedCategoryType === 'INTERNAL_REPORT');
      const isSchool = (normalizedCategoryType === 'SCHOOL_REPORT' || normalizedReportCategory === 'SCHOOL');
      const explicitRequiresSeal = (docData.requiresSeal === true || docData.requiresSeal === 'true') ? true : ((docData.requiresSeal === false || docData.requiresSeal === 'false') ? false : undefined);
      const requiresSeal = isInternal ? false : (explicitRequiresSeal !== undefined ? explicitRequiresSeal : isSchool);
      const isCallerBgh = Boolean(currentUser && (currentUser.role === 'BGH' || currentUser.role === 'ADMIN' || (typeof currentUser.department === 'string' && currentUser.department.includes('Ban Giám hiệu'))));
      const hasSchoolSeal = (!isInternal) && isCallerBgh && (docData.verifiedSchoolSeal === true);
      const sealedAt = (hasSchoolSeal && typeof docData.sealedAt === 'string' && docData.sealedAt.trim()) ? docData.sealedAt.trim() : null;
      const bghApprovedAt = (isCallerBgh && (!isInternal) && typeof docData.bghApprovedAt === 'string' && docData.bghApprovedAt.trim()) ? docData.bghApprovedAt.trim() : null;
      const bghSigner = (bghApprovedAt && currentUser) ? (currentUser.fullName || currentUser.name || currentUser.username || null) : null;

      return {
        signType: normalizedSignType,
        isCopySign: isCopy,
        reportCategory: normalizedReportCategory,
        categoryType: normalizedCategoryType,
        requiresSeal,
        hasSchoolSeal,
        sealedAt,
        bghApprovedAt,
        bghSigner
      };
    })(),
    driveInfo: (docData.driveInfo && typeof docData.driveInfo === 'object') ? docData.driveInfo : null,
    googleDriveUrl: isValidGoogleDriveUrl(docData.googleDriveUrl) ? docData.googleDriveUrl : null,
    googleDriveFolder: (typeof docData.googleDriveFolder === 'string' && docData.googleDriveFolder.trim()) ? docData.googleDriveFolder.trim() : null,
    googleDriveFileName: (typeof docData.googleDriveFileName === 'string' && docData.googleDriveFileName.trim()) ? docData.googleDriveFileName.trim() : null,
    payloadHash: (typeof docData.payloadHash === 'string' && docData.payloadHash.trim()) ? docData.payloadHash.trim() : null,
    logs: [
      {
        time: new Date().toISOString().replace('T', ' ').substring(0, 19),
        actor: (currentUser && (currentUser.name || currentUser.fullName || currentUser.username)) || authorName || 'SYSTEM',
        action: `Khởi tạo và nộp hồ sơ "${docData.title}" (${category === 'PERSONAL' ? 'Giáo án cá nhân' : 'Báo cáo liên cấp'})`
      }
    ]
  };

  docs.unshift(newDoc);
  _docsCache = docs;
  saveJsonSafeSync(DOCS_FILE, docs);
  Promise.resolve(syncDocToFirebase(newDoc)).catch(e => console.warn('[Firebase Sync] Lỗi nền:', e.message));
  return newDoc;
}

const FIREBASE_RTDB_URL = 'https://edusign-school-default-rtdb.asia-southeast1.firebasedatabase.app';

async function syncDocToFirebase(doc) {
  if (!doc || !doc.id) return null;
  const cleanDoc = { ...doc };
  delete cleanDoc.fileBase64;
  delete cleanDoc.signedPdfBase64;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${FIREBASE_RTDB_URL}/documents/${encodeURIComponent(doc.id)}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(cleanDoc),
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`Firebase RTDB phản hồi lỗi HTTP ${res.status}: ${res.statusText}`);
    }
    return await res.json();
  } catch (err) {
    console.warn(`[Firebase Sync Doc] Lỗi đồng bộ ngầm cho [${doc.id}]:`, err.message);
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

async function syncSignatureToFirebase(userId, signatureImage) {
  if (typeof userId !== 'string' || !userId.trim() || userId.length > 100) return null;
  if (typeof signatureImage !== 'string' || !signatureImage.trim()) return null;

  // Giới hạn kích thước ảnh chữ ký: tối đa 2MB (tránh làm tràn payload Firebase RTDB hoặc DoS RAM)
  const MAX_SIG_SIZE = 2 * 1024 * 1024;
  if (signatureImage.length > MAX_SIG_SIZE) {
    console.warn(`[Firebase Sync Sig] Kích thước ảnh chữ ký của [${userId}] vượt quá ngưỡng tối đa cho phép (2MB).`);
    return null;
  }

  // Xác thực định dạng: Data URI hình ảnh hợp lệ (png, jpeg, jpg, webp) hoặc chuỗi Base64 hợp chuẩn
  const isDataUri = /^data:image\/(png|jpeg|jpg|webp);base64,[A-Za-z0-9+/=\s]+$/i.test(signatureImage);
  const isPureBase64 = /^[A-Za-z0-9+/=\s]+$/.test(signatureImage);
  if (!isDataUri && !isPureBase64) {
    console.warn(`[Firebase Sync Sig] Định dạng ảnh chữ ký của [${userId}] không hợp lệ.`);
    return null;
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 8000);
  try {
    const res = await fetch(`${FIREBASE_RTDB_URL}/signatures/${encodeURIComponent(userId.trim())}.json`, {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        signatureImage: signatureImage.trim(),
        updatedAt: new Date().toISOString()
      }),
      signal: controller.signal
    });
    if (!res.ok) {
      throw new Error(`Firebase RTDB phản hồi lỗi HTTP ${res.status}: ${res.statusText}`);
    }
    return await res.json();
  } catch (err) {
    console.warn(`[Firebase Sync Sig] Lỗi đồng bộ ngầm cho [${userId}]:`, err.message);
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

function updateDocument(id, updates) {
  if (typeof id !== 'string' || !id.trim() || id.length > 100) {
    throw new Error('[dataStore updateDocument] ID hồ sơ không hợp lệ hoặc vượt quá độ dài tối đa.');
  }
  const cleanId = id.trim();
  const docs = getDocuments();
  const index = docs.findIndex(d => d.id === cleanId);
  if (index === -1) throw new Error('Không tìm thấy hồ sơ!');

  if (!updates || typeof updates !== 'object' || Array.isArray(updates)) {
    throw new Error('[dataStore updateDocument] Dữ liệu cập nhật hồ sơ không hợp lệ.');
  }

  const cleanUpdates = { ...updates };
  if (cleanUpdates.fileBase64 && (!cleanUpdates.filePath || !docs[index].filePath)) {
    if (typeof cleanUpdates.fileBase64 !== 'string') {
      throw new Error('[dataStore updateDocument] fileBase64 phải là chuỗi ký tự.');
    }
    const MAX_BASE64_LEN = 35 * 1024 * 1024;
    if (cleanUpdates.fileBase64.length > MAX_BASE64_LEN) {
      throw new Error('[dataStore updateDocument] Dữ liệu fileBase64 vượt quá giới hạn tối đa cho phép (35MB).');
    }
    const uploadDir = path.join(__dirname, 'uploads', 'documents');
    if (!fs.existsSync(uploadDir)) fs.mkdirSync(uploadDir, { recursive: true });
    const cleanBase64 = cleanUpdates.fileBase64.replace(/^data:[^;]+;base64,/, '').trim();
    if (!/^[A-Za-z0-9+/=]+$/.test(cleanBase64.replace(/\s+/g, ''))) {
      throw new Error('[dataStore updateDocument] Chuỗi fileBase64 không đúng định dạng base64 hợp lệ.');
    }
    const rawBuffer = Buffer.from(cleanBase64, 'base64');
    if (rawBuffer.length < 50) {
      throw new Error('[dataStore updateDocument] Dữ liệu file nhị phân cập nhật quá nhỏ hoặc không hợp lệ.');
    }
    // Xác thực magic bytes header chuẩn của file PDF (%PDF-)
    if (rawBuffer.toString('utf8', 0, 5) !== '%PDF-') {
      throw new Error('[dataStore updateDocument] Tệp tải lên không phải là định dạng PDF hợp lệ (thiếu header %PDF-).');
    }
    const safeId = cleanId.replace(/[^a-zA-Z0-9_\-]/g, '_');
    const fname = `doc_${safeId}_updated.pdf`;
    const fpath = path.join(uploadDir, fname);
    const tempFpath = `${fpath}.${Date.now()}.${Math.random().toString(36).slice(2, 6)}.tmp`;
    try {
      fs.writeFileSync(tempFpath, rawBuffer);
      fs.renameSync(tempFpath, fpath);
      cleanUpdates.filePath = `uploads/documents/${fname}`;
    } catch (writeErr) {
      if (fs.existsSync(tempFpath)) {
        try { fs.unlinkSync(tempFpath); } catch (uErr) { console.warn('[dataStore updateDocument] Lỗi dọn tệp tạm:', uErr.message); }
      }
      throw new Error(`[dataStore updateDocument] Lỗi lưu tệp nhị phân cập nhật: ${writeErr.message}`);
    }
  }

  delete cleanUpdates.fileBase64;
  delete cleanUpdates.signedPdfBase64;
  if (cleanUpdates.filePath) cleanUpdates.filePath = normalizeFilePath(cleanUpdates.filePath);
  if (cleanUpdates.realSignedPath) cleanUpdates.realSignedPath = normalizeFilePath(cleanUpdates.realSignedPath);

  const updatedDoc = { ...docs[index], ...cleanUpdates };
  const newDocs = docs.map((d, i) => i === index ? updatedDoc : d);
  saveJsonSafeSync(DOCS_FILE, newDocs);
  _docsCache = newDocs;
  Promise.resolve(syncDocToFirebase(updatedDoc)).catch(e => console.warn('[Firebase Sync] Lỗi nền update:', e.message));
  return updatedDoc;
}

function archiveDocument(id, driveInfo = null) {
  if (typeof id !== 'string' || !id.trim() || id.length > 100) {
    throw new Error('[dataStore archiveDocument] ID hồ sơ không hợp lệ hoặc vượt quá độ dài tối đa.');
  }
  const cleanId = id.trim();
  const docs = getDocuments();
  const index = docs.findIndex(d => d.id === cleanId);
  if (index === -1) throw new Error('Không tìm thấy hồ sơ để lưu trữ!');

  const doc = docs[index];
  doc.isArchived = true;
  doc.status = 'ARCHIVED';
  doc.archivedAt = new Date().toISOString();
  if (driveInfo && typeof driveInfo === 'object') doc.driveInfo = driveInfo;

  saveJsonSafeSync(DOCS_FILE, docs);
  _docsCache = docs;
  Promise.resolve(syncDocToFirebase(doc)).catch(e => console.warn('[Firebase Sync] Lỗi nền archive:', e.message));
  return doc;
}

async function deleteDocFromFirebase(docId, maxRetries = 3) {
  if (typeof docId !== 'string' || !docId.trim()) return false;
  const cleanId = docId.trim();
  for (let attempt = 1; attempt <= maxRetries; attempt++) {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(`${FIREBASE_RTDB_URL}/documents/${encodeURIComponent(cleanId)}.json`, {
        method: 'DELETE',
        signal: controller.signal
      });
      if (!res.ok) {
        throw new Error(`Firebase RTDB DELETE phản hồi HTTP ${res.status}: ${res.statusText}`);
      }
      return true;
    } catch (err) {
      console.warn(`[Firebase Delete Doc] Lần thử ${attempt}/${maxRetries} xóa [${cleanId}] thất bại:`, err.message);
      if (attempt === maxRetries) {
        console.error(`[Firebase Delete Doc] Thất bại hoàn toàn sau ${maxRetries} lần thử xóa [${cleanId}] trên Firebase RTDB.`);
        throw err;
      }
      await new Promise(resolve => setTimeout(resolve, attempt * 300));
    } finally {
      clearTimeout(timeoutId);
    }
  }
  return false;
}

function deleteDocument(id) {
  if (typeof id !== 'string' || !id.trim() || id.length > 100) {
    return false;
  }
  const cleanId = id.trim();
  let docs = getDocuments(true);
  const originalLength = docs.length;
  const newDocs = docs.filter(d => d && d.id !== cleanId);
  if (newDocs.length === originalLength) {
    return false; // Bản ghi không tồn tại
  }
  saveJsonSafeSync(DOCS_FILE, newDocs);
  _docsCache = newDocs;

  // Xóa tài liệu khỏi Firebase RTDB trong chế độ nền kèm retry và kiểm tra response.ok
  deleteDocFromFirebase(cleanId).catch(err => {
    console.warn(`[dataStore deleteDocument] Cảnh báo đồng bộ xóa Firebase thất bại:`, err.message);
  });

  return true;
}

const BGH_CONFIG_FILE = path.join(DATA_DIR, 'bgh_signing_config.json');
let _bghConfigCache = null;

function getBghSigningConfig(forceReload = false) {
  if (!forceReload && _bghConfigCache) {
    return { ..._bghConfigCache };
  }

  const fallback = {
    signType: (process.env.BGH_SIGN_TYPE === 'SMART_CA') ? 'SMART_CA' : 'USB_TOKEN',
    serialNumber: (typeof process.env.BGH_SERIAL_NUMBER === 'string') ? process.env.BGH_SERIAL_NUMBER.trim() : '',
    certOwner: (typeof process.env.BGH_CERT_OWNER === 'string') ? process.env.BGH_CERT_OWNER.trim() : '',
    cccd: (typeof process.env.BGH_CCCD === 'string') ? process.env.BGH_CCCD.trim() : '',
    school: (typeof process.env.BGH_SCHOOL === 'string') ? process.env.BGH_SCHOOL.trim() : 'TRƯỜNG TRUNG HỌC CƠ SỞ CHU VĂN AN',
    updatedAt: new Date().toISOString()
  };

  try {
    if (fs.existsSync(BGH_CONFIG_FILE)) {
      const raw = fs.readFileSync(BGH_CONFIG_FILE, 'utf8');
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        _bghConfigCache = {
          signType: (parsed.signType === 'SMART_CA') ? 'SMART_CA' : 'USB_TOKEN',
          serialNumber: (typeof parsed.serialNumber === 'string') ? parsed.serialNumber.trim() : fallback.serialNumber,
          certOwner: (typeof parsed.certOwner === 'string') ? parsed.certOwner.trim() : fallback.certOwner,
          cccd: (typeof parsed.cccd === 'string') ? parsed.cccd.trim() : fallback.cccd,
          school: (typeof parsed.school === 'string') ? parsed.school.trim() : fallback.school,
          updatedAt: (typeof parsed.updatedAt === 'string') ? parsed.updatedAt : fallback.updatedAt
        };
        return { ..._bghConfigCache };
      }
    }
  } catch (err) {
    console.warn('[dataStore] Lỗi đọc cấu hình BGH từ đĩa:', err.message);
  }

  _bghConfigCache = { ...fallback };
  return { ..._bghConfigCache };
}

function saveBghSigningConfig(config) {
  if (!config || typeof config !== 'object' || Array.isArray(config)) {
    throw new Error('[dataStore saveBghSigningConfig] Cấu hình BGH không hợp lệ.');
  }

  const current = getBghSigningConfig();
  const updated = { ...current };

  // Whitelist và xác thực nghiêm ngặt từng trường cấu hình hợp lệ
  if (config.signType !== undefined) {
    if (config.signType !== 'USB_TOKEN' && config.signType !== 'SMART_CA') {
      throw new Error('[dataStore saveBghSigningConfig] signType phải là USB_TOKEN hoặc SMART_CA.');
    }
    updated.signType = config.signType;
  }

  if (config.serialNumber !== undefined) {
    if (typeof config.serialNumber !== 'string' || config.serialNumber.length > 100) {
      throw new Error('[dataStore saveBghSigningConfig] serialNumber phải là chuỗi không quá 100 ký tự.');
    }
    updated.serialNumber = config.serialNumber.trim();
  }

  if (config.certOwner !== undefined) {
    if (typeof config.certOwner !== 'string' || config.certOwner.length > 150) {
      throw new Error('[dataStore saveBghSigningConfig] certOwner phải là chuỗi không quá 150 ký tự.');
    }
    updated.certOwner = config.certOwner.trim();
  }

  if (config.cccd !== undefined) {
    if (typeof config.cccd !== 'string' || config.cccd.length > 30) {
      throw new Error('[dataStore saveBghSigningConfig] cccd phải là chuỗi không quá 30 ký tự.');
    }
    updated.cccd = config.cccd.trim();
  }

  if (config.school !== undefined) {
    if (typeof config.school !== 'string' || config.school.length > 250) {
      throw new Error('[dataStore saveBghSigningConfig] school phải là chuỗi không quá 250 ký tự.');
    }
    updated.school = config.school.trim();
  }

  updated.updatedAt = new Date().toISOString();

  _bghConfigCache = { ...updated };
  saveJsonSafeSync(BGH_CONFIG_FILE, _bghConfigCache);
  return { ..._bghConfigCache };
}

module.exports = {
  DEPARTMENTS,
  getUsers,
  saveUsers,
  getUserById,
  getUserByUsername,
  createUser,
  updateUser,
  toggleUserLock,
  getSigners,
  resetPassword,
  deleteUser,
  getDepartments,
  saveDepartments,
  getDepartmentById,
  createDepartment,
  updateDepartment,
  deleteDepartment,
  getSubscriptions,
  saveSubscriptions,
  saveSubscription,
  getSubscriptionsForUser,
  getDocuments,
  saveDocuments,
  flushDocuments,
  waitForPendingWrites,
  saveJsonSafe,
  saveJsonSafeSync,
  getDocumentById,
  createDocument,
  addDocument: createDocument,
  updateDocument,
  deleteDocument,
  archiveDocument,
  normalizeFilePath,
  resolveFilePath,
  getBghSigningConfig,
  saveBghSigningConfig,
  isDocArchived,
  sanitizeDocuments,
  syncSignatureToFirebase,
  deleteDocFromFirebase,
  hashPassword,
  hashPasswordSync,
  verifyPassword
};

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');

const CONFIG_FILE = path.join(__dirname, 'onedrive_config.json');

// Cache detected root in memory with TTL (60 seconds) to avoid repeated disk traversals
let cachedDetectedRoot = null;
let lastDetectionTime = 0;
const DETECTION_CACHE_TTL = 60000;

/**
 * Tự động dò tìm thư mục OneDrive của Sở GD&ĐT Quảng Ngãi & Trường THCS Chu Văn An trên máy tính
 */
function findOneDriveSharedFolder() {
  const now = Date.now();
  if (cachedDetectedRoot !== null && (now - lastDetectionTime < DETECTION_CACHE_TTL)) {
    try {
      if (fs.existsSync(cachedDetectedRoot)) {
        return cachedDetectedRoot;
      }
    } catch (e) {
      cachedDetectedRoot = null;
    }
  }

  const userProfile = process.env.USERPROFILE || process.env.HOME || os.homedir();
  if (!userProfile || typeof userProfile !== 'string') return null;

  // 1. Kiểm tra chính xác thư mục chia sẻ năm học 2026-2027 của Thầy Hà Văn Tý
  const exactCandidates = [
    path.join(userProfile, 'OneDrive - Sở GD&ĐT Quảng Ngãi', "Trường THCS Chu Văn An (Đăk Hà)'s files - 15. HÀ VĂN TÝ 26-27"),
    path.join(userProfile, 'OneDrive - Sở GD&ĐT Quảng Ngãi', "Trường THCS Chu Văn An (Đăk Hà)'s files - 12. HÀ VĂN TÝ"),
    path.join(userProfile, 'OneDrive - Sở GD&ĐT Quảng Ngãi')
  ];

  for (const cand of exactCandidates) {
    try {
      if (fs.existsSync(cand)) {
        cachedDetectedRoot = cand;
        lastDetectionTime = now;
        return cand;
      }
    } catch (candErr) {
      console.warn('Không thể kiểm tra đường dẫn ứng viên OneDrive:', cand, candErr.message);
    }
  }

  // 2. Quét động các thư mục OneDrive khác trong User Profile
  try {
    const userDirs = fs.readdirSync(userProfile);
    for (const d of userDirs) {
      if (typeof d === 'string' && d.toLowerCase().includes('onedrive')) {
        const full = path.join(userProfile, d);
        try {
          if (fs.existsSync(full) && fs.statSync(full).isDirectory()) {
            try {
              const subDirs = fs.readdirSync(full);
              for (const sub of subDirs) {
                if (typeof sub === 'string' && (sub.includes('Chu Văn An') || sub.includes('HÀ VĂN TÝ'))) {
                  const match = path.join(full, sub);
                  cachedDetectedRoot = match;
                  lastDetectionTime = now;
                  return match;
                }
              }
            } catch (subErr) {
              console.warn(`Không thể quét thư mục con OneDrive ${full}:`, subErr.message);
            }
            cachedDetectedRoot = full;
            lastDetectionTime = now;
            return full;
          }
        } catch (statErr) {
          console.warn(`Không thể kiểm tra thuộc tính thư mục OneDrive ${full}:`, statErr.message);
        }
      }
    }
  } catch (e) {
    console.warn(`Không thể quét User Profile ${userProfile}:`, e.message);
  }

  return null;
}

function getOneDriveConfig() {
  const detectedRoot = findOneDriveSharedFolder();
  let cfg = {
    enabled: true,
    autoSyncOnSign: true,
    storageQuota: '5 TB',
    schoolName: 'Trường THCS Chu Văn An (Đăk Hà)',
    department: 'Sở GD&ĐT Quảng Ngãi',
    teacherName: 'Hà Văn Tý',
    academicYear: '2026 - 2027',
    oneDriveFolderPath: detectedRoot || '',
    detected: Boolean(detectedRoot)
  };

  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const saved = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (saved && typeof saved === 'object' && !Array.isArray(saved)) {
        if (typeof saved.enabled === 'boolean') cfg.enabled = saved.enabled;
        if (typeof saved.autoSyncOnSign === 'boolean') cfg.autoSyncOnSign = saved.autoSyncOnSign;
        if (typeof saved.storageQuota === 'string' && saved.storageQuota.trim()) {
          cfg.storageQuota = saved.storageQuota.trim().slice(0, 30);
        }
        if (typeof saved.schoolName === 'string') cfg.schoolName = saved.schoolName.trim().slice(0, 150);
        if (typeof saved.department === 'string') cfg.department = saved.department.trim().slice(0, 150);
        if (typeof saved.teacherName === 'string') cfg.teacherName = saved.teacherName.trim().slice(0, 100);
        if (typeof saved.academicYear === 'string') cfg.academicYear = saved.academicYear.trim().slice(0, 50);
        if (typeof saved.oneDriveFolderPath === 'string' && saved.oneDriveFolderPath.trim()) {
          cfg.oneDriveFolderPath = saved.oneDriveFolderPath.trim();
        }
        if (!cfg.oneDriveFolderPath && detectedRoot) {
          cfg.oneDriveFolderPath = detectedRoot;
        }
        cfg.detected = Boolean(cfg.oneDriveFolderPath && fs.existsSync(cfg.oneDriveFolderPath));
      }
    } catch (e) {
      console.warn('Lỗi đọc onedrive_config.json:', e.message);
    }
  }

  return cfg;
}

function saveOneDriveConfig(newCfg) {
  if (!newCfg || typeof newCfg !== 'object' || Array.isArray(newCfg)) return false;
  try {
    const current = getOneDriveConfig();
    const folderPath = (typeof newCfg.oneDriveFolderPath === 'string' && newCfg.oneDriveFolderPath.trim())
      ? newCfg.oneDriveFolderPath.trim()
      : current.oneDriveFolderPath;

    let isDetected = false;
    if (folderPath && typeof folderPath === 'string') {
      try {
        isDetected = fs.existsSync(folderPath);
      } catch (checkErr) {
        console.warn('Không thể kiểm tra sự tồn tại của thư mục OneDrive:', folderPath, checkErr.message);
      }
    }

    const safeData = {
      enabled: typeof newCfg.enabled === 'boolean' ? newCfg.enabled : current.enabled,
      autoSyncOnSign: typeof newCfg.autoSyncOnSign === 'boolean' ? newCfg.autoSyncOnSign : current.autoSyncOnSign,
      storageQuota: typeof newCfg.storageQuota === 'string' && newCfg.storageQuota.trim() ? newCfg.storageQuota.trim().slice(0, 30) : current.storageQuota,
      schoolName: typeof newCfg.schoolName === 'string' ? newCfg.schoolName.trim().slice(0, 150) : current.schoolName,
      department: typeof newCfg.department === 'string' ? newCfg.department.trim().slice(0, 150) : current.department,
      teacherName: typeof newCfg.teacherName === 'string' ? newCfg.teacherName.trim().slice(0, 100) : current.teacherName,
      academicYear: typeof newCfg.academicYear === 'string' ? newCfg.academicYear.trim().slice(0, 50) : current.academicYear,
      oneDriveFolderPath: folderPath || '',
      detected: isDetected
    };

    const tmpPath = `${CONFIG_FILE}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`;
    fs.writeFileSync(tmpPath, JSON.stringify(safeData, null, 2), 'utf8');
    try {
      fs.renameSync(tmpPath, CONFIG_FILE);
    } catch (renameErr) {
      fs.copyFileSync(tmpPath, CONFIG_FILE);
      try { fs.unlinkSync(tmpPath); } catch (uErr) {
        console.warn('Không thể dọn file tmp cấu hình OneDrive:', uErr.message);
      }
    }
    return true;
  } catch (err) {
    console.warn('Lỗi lưu cấu hình onedrive_config.json:', err.message);
    return false;
  }
}

/**
 * Phân loại thư mục lưu trữ theo chuyên môn
 */
function resolveSubCategory(doc) {
  const t = (doc && typeof doc.title === 'string' ? doc.title : '').toLowerCase();
  const fn = (doc && typeof doc.fileName === 'string' ? doc.fileName : '').toLowerCase();

  if (t.includes('giáo dục') || t.includes('phụ lục') || t.includes('khgd') || fn.includes('pl') || fn.includes('khgd')) {
    return '1. KẾ HOẠCH GIÁO DỤC CÁ NHÂN';
  }
  if (t.includes('dự giờ') || fn.includes('du_gio')) {
    return '4. SỔ DỰ GIỜ';
  }
  if (t.includes('chủ nhiệm') || fn.includes('chu_nhiem')) {
    return '6. CÔNG TÁC CHỦ NHIỆM';
  }
  if (t.includes('chất lượng') || fn.includes('chat_luong')) {
    return '3. THEO DÕI CHẤT LƯỢNG DẠY HỌC';
  }

  return '2. KẾ HOẠCH BÀI DẠY';
}

/**
 * Tự động đồng bộ file PDF đã ký số vào thư mục OneDrive của trường
 */
async function syncDocumentToOneDrive(doc, pdfFilePath) {
  if (!doc || typeof doc !== 'object') {
    throw new Error('Dữ liệu hồ sơ không hợp lệ để đồng bộ OneDrive');
  }
  if (!pdfFilePath || typeof pdfFilePath !== 'string') {
    throw new Error('Đường dẫn tệp PDF không hợp lệ');
  }

  const cfg = getOneDriveConfig();
  const root = cfg.oneDriveFolderPath || findOneDriveSharedFolder();

  if (!root || !fs.existsSync(root)) {
    throw new Error('Chưa tìm thấy thư mục đồng bộ OneDrive trên máy tính. Thầy vui lòng kiểm tra ứng dụng OneDrive!');
  }

  if (!fs.existsSync(pdfFilePath)) {
    throw new Error('Tệp PDF ký số không tồn tại tại: ' + pdfFilePath);
  }

  const category = resolveSubCategory(doc);
  const targetDir = path.join(root, category);

  if (!fs.existsSync(targetDir)) {
    fs.mkdirSync(targetDir, { recursive: true });
  }

  // Đối soát đường dẫn vật lý thực tế (Canonical Realpath Resolution)
  const realRootDir = fs.realpathSync(root);
  const realTargetDir = fs.realpathSync(targetDir);
  if (!realTargetDir.startsWith(realRootDir + path.sep) && realTargetDir !== realRootDir) {
    throw new Error('Thư mục đích vật lý nằm ngoài phạm vi thư mục OneDrive cho phép');
  }

  const fileExt = path.extname(pdfFilePath) || '.pdf';
  const cleanTitle = (typeof doc.title === 'string' && doc.title.trim() ? doc.title : 'GiaoAn')
    .replace(/[/\\?%*:|"<>]/g, '_')
    .replace(/\.\.+/g, '_')
    .trim();
  const rawWeek = typeof doc.week === 'string' ? doc.week.trim() : '';
  const cleanWeek = rawWeek.replace(/[/\\?%*:|"<>]/g, '_').replace(/\.\.+/g, '_').replace(/\s+/g, '_');
  const weekInfo = cleanWeek ? ('_' + cleanWeek) : '';
  const rawDept = typeof doc.department === 'string' && doc.department.trim() ? doc.department.trim() : 'To_Toan_Tin';
  const cleanDept = rawDept.replace(/[/\\?%*:|"<>]/g, '_').replace(/\.\.+/g, '_').replace(/\s+/g, '_');
  const finalFileName = '[' + cleanDept + ']' + weekInfo + '_' + cleanTitle + '_DaKySo' + fileExt;

  const normalizedDest = path.join(realTargetDir, finalFileName);
  if (path.dirname(normalizedDest) !== realTargetDir) {
    throw new Error('Đường dẫn tệp đích không an toàn hoặc nằm ngoài thư mục chỉ định');
  }

  // Xác minh toàn diện realTargetDir và toàn bộ chuỗi thư mục cha không chứa symlink hoặc junction / reparse point
  let verifyDir = realTargetDir;
  while (verifyDir && verifyDir !== path.dirname(verifyDir)) {
    const dirLstat = fs.lstatSync(verifyDir);
    if (dirLstat.isSymbolicLink()) {
      throw new Error('Thư mục cha chứa liên kết tượng trưng (symlink) không an toàn: ' + verifyDir);
    }
    const dirReal = fs.realpathSync(verifyDir);
    if (dirReal.toLowerCase() !== verifyDir.toLowerCase()) {
      throw new Error('Thư mục cha chứa điểm nối (junction/reparse point) không an toàn: ' + verifyDir);
    }
    if (verifyDir.toLowerCase() === realRootDir.toLowerCase()) {
      break;
    }
    verifyDir = path.dirname(verifyDir);
  }

  // Kiểm tra liên kết tượng trưng (symlink) trước khi mở tệp đích
  try {
    const lstat = fs.lstatSync(normalizedDest);
    if (lstat.isSymbolicLink()) {
      throw new Error('Từ chối ghi tệp: Đích đến là liên kết tượng trưng (symlink)');
    }
  } catch (lstatErr) {
    if (lstatErr.code !== 'ENOENT') {
      throw lstatErr;
    }
  }

  // Đọc nội dung tệp nguồn
  const pdfBuffer = fs.readFileSync(pdfFilePath);

  // Cơ chế tạo và ghi tệp an toàn chống TOCTOU race condition:
  // 1. Ghi vào tệp tạm ngẫu nhiên duy nhất với cờ O_CREAT | O_EXCL (bảo đảm tệp chưa từng tồn tại, triệt tiêu nguy cơ tráo đổi symlink)
  // 2. Trên POSIX bắt buộc phải có cờ O_NOFOLLOW
  if (process.platform !== 'win32' && !fs.constants.O_NOFOLLOW) {
    throw new Error('Nền tảng POSIX không hỗ trợ cơ chế O_NOFOLLOW chống symlink');
  }

  const tempNonce = crypto.randomBytes(16).toString('hex');
  const tempDest = path.join(realTargetDir, '.' + finalFileName + '.' + tempNonce + '.tmp');

  let openFlags = fs.constants.O_WRONLY | fs.constants.O_CREAT | fs.constants.O_EXCL;
  if (fs.constants.O_NOFOLLOW) {
    openFlags |= fs.constants.O_NOFOLLOW;
  }

  const tempFd = fs.openSync(tempDest, openFlags, 0o600);
  let writeCompleted = false;
  try {
    fs.writeFileSync(tempFd, pdfBuffer);
    writeCompleted = true;
  } finally {
    try {
      fs.closeSync(tempFd);
    } catch (closeErr) {
      console.warn('Lỗi đóng file descriptor tạm OneDrive:', closeErr.message);
    }
    if (!writeCompleted) {
      try {
        fs.unlinkSync(tempDest);
      } catch (unlinkErr) {
        if (unlinkErr.code !== 'ENOENT') {
          console.warn('Lỗi dọn tệp tạm OneDrive khi ghi thất bại:', unlinkErr.message);
        }
      }
    }
  }

  try {
    // Xác minh tệp tạm không bị biến thành symlink
    const tempLstat = fs.lstatSync(tempDest);
    if (tempLstat.isSymbolicLink()) {
      throw new Error('Phát hiện tệp tạm bị can thiệp bởi liên kết tượng trưng');
    }

    // Nếu đích đến đã tồn tại, kiểm tra nghiêm ngặt symlink trước khi hoán đổi nguyên tử
    try {
      const existingLstat = fs.lstatSync(normalizedDest);
      if (existingLstat.isSymbolicLink()) {
        throw new Error('Từ chối ghi tệp: Đích đến là liên kết tượng trưng (symlink)');
      }
    } catch (existErr) {
      if (existErr.code !== 'ENOENT') {
        throw existErr;
      }
    }

    // Hoán đổi nguyên tử đưa tệp vào đích mà không xóa trước, bảo toàn tính toàn vẹn dữ liệu
    fs.renameSync(tempDest, normalizedDest);

    // Đối soát tính toàn vẹn sau khi hoán đổi (Post-replacement invariant verification)
    const postLstat = fs.lstatSync(normalizedDest);
    if (postLstat.isSymbolicLink()) {
      try {
        fs.unlinkSync(normalizedDest);
      } catch (cleanupErr) {
        console.warn('Lỗi dọn tệp symlink không an toàn:', cleanupErr.message);
      }
      throw new Error('Phát hiện tệp đích bị thay thế bằng liên kết tượng trưng sau khi ghi');
    }
    const postRealpath = fs.realpathSync(normalizedDest);
    const isTargetDirMatch = process.platform === 'win32'
      ? path.dirname(postRealpath).toLowerCase() === realTargetDir.toLowerCase()
      : path.dirname(postRealpath) === realTargetDir;
    if (!isTargetDirMatch) {
      try {
        fs.unlinkSync(normalizedDest);
      } catch (cleanupErr) {
        console.warn('Lỗi dọn tệp đích không an toàn:', cleanupErr.message);
      }
      throw new Error('Tệp đích bị chuyển hướng ra ngoài thư mục đích an toàn');
    }
  } catch (syncErr) {
    try {
      fs.unlinkSync(tempDest);
    } catch (cleanupErr) {
      if (cleanupErr.code !== 'ENOENT') {
        console.warn('Lỗi dọn tệp tạm OneDrive sau hoán đổi:', cleanupErr.message);
      }
    }
    throw syncErr;
  }

  const stats = fs.statSync(normalizedDest);
  const nowStr = new Date().toISOString().replace('T', ' ').substring(0, 19);

  return {
    success: true,
    fileName: finalFileName,
    category: category,
    destinationPath: normalizedDest,
    fileSize: stats.size,
    syncedAt: nowStr,
    oneDriveRoot: root,
    message: 'Đã nộp thành công vào OneDrive: ' + category + ' / ' + finalFileName
  };
}

module.exports = {
  getOneDriveConfig,
  saveOneDriveConfig,
  syncDocumentToOneDrive,
  findOneDriveSharedFolder,
  resolveSubCategory
};

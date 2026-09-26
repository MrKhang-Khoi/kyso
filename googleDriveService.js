const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CONFIG_FILE = fs.existsSync(path.join(__dirname, '..', 'drive_config.json'))
  ? path.join(__dirname, '..', 'drive_config.json')
  : path.join(__dirname, 'drive_config.json');

const ALLOWED_DOCS_ROOT = path.resolve(__dirname);
const MAX_PDF_BYTES = 35 * 1024 * 1024; // 35 MB

function isPathInsideAllowedRoot(targetPath, rootDir) {
  try {
    const realRoot = fs.existsSync(rootDir) ? fs.realpathSync(rootDir) : path.resolve(rootDir);
    const realTarget = fs.existsSync(targetPath) ? fs.realpathSync(targetPath) : path.resolve(targetPath);
    const rel = path.relative(realRoot, realTarget).replace(/\\/g, '/');
    return !rel.startsWith('..') && !path.isAbsolute(rel);
  } catch {
    return false;
  }
}

// Cấu hình Google Drive của nhà trường
function getDriveConfig() {
  const envUrl = (process.env.GAS_WEBHOOK_URL || '').trim();
  const envSecret = (process.env.ZALO_WEBHOOK_SECRET || process.env.GAS_WEBHOOK_SECRET || '').trim();

  let fileCfg = {};
  if (fs.existsSync(CONFIG_FILE)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(CONFIG_FILE, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
        fileCfg = parsed;
      }
    } catch (e) {
      console.warn('[GoogleDriveService] Cảnh báo đọc drive_config.json:', e.message);
    }
  }

  const rawUrl = typeof fileCfg.gasWebhookUrl === 'string' ? fileCfg.gasWebhookUrl.trim() : envUrl;
  const validUrl = rawUrl.startsWith('http://') || rawUrl.startsWith('https://') ? rawUrl : '';
  const rawSecret = typeof fileCfg.gasWebhookSecret === 'string' ? fileCfg.gasWebhookSecret.trim() : envSecret;

  return {
    enabled: typeof fileCfg.enabled === 'boolean' ? fileCfg.enabled : true,
    autoUploadOnSign: typeof fileCfg.autoUploadOnSign === 'boolean' ? fileCfg.autoUploadOnSign : true,
    schoolFolderId: typeof fileCfg.schoolFolderId === 'string' && fileCfg.schoolFolderId.trim()
      ? fileCfg.schoolFolderId.trim()
      : 'THCS_CHU_VAN_AN_ARCHIVE_2026',
    schoolFolderName: typeof fileCfg.schoolFolderName === 'string' && fileCfg.schoolFolderName.trim()
      ? fileCfg.schoolFolderName.trim()
      : 'KHO_HO_SO_SO_TRUONG_THCS_CHU_VAN_AN',
    gasWebhookUrl: validUrl,
    gasWebhookSecret: rawSecret,
    spreadsheetId: typeof fileCfg.spreadsheetId === 'string' ? fileCfg.spreadsheetId.trim() : '',
    backupLocalStorage: typeof fileCfg.backupLocalStorage === 'boolean' ? fileCfg.backupLocalStorage : true
  };
}

function saveDriveConfig(cfg) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg)) {
    throw new Error('Dữ liệu cấu hình Google Drive không hợp lệ.');
  }

  const cleanConfig = {
    enabled: typeof cfg.enabled === 'boolean' ? cfg.enabled : true,
    autoUploadOnSign: typeof cfg.autoUploadOnSign === 'boolean' ? cfg.autoUploadOnSign : true,
    schoolFolderId: typeof cfg.schoolFolderId === 'string' ? cfg.schoolFolderId.trim() : 'THCS_CHU_VAN_AN_ARCHIVE_2026',
    schoolFolderName: typeof cfg.schoolFolderName === 'string' ? cfg.schoolFolderName.trim() : 'KHO_HO_SO_SO_TRUONG_THCS_CHU_VAN_AN',
    gasWebhookUrl: typeof cfg.gasWebhookUrl === 'string' ? cfg.gasWebhookUrl.trim() : '',
    gasWebhookSecret: typeof cfg.gasWebhookSecret === 'string' ? cfg.gasWebhookSecret.trim() : '',
    spreadsheetId: typeof cfg.spreadsheetId === 'string' ? cfg.spreadsheetId.trim() : '',
    backupLocalStorage: typeof cfg.backupLocalStorage === 'boolean' ? cfg.backupLocalStorage : true
  };

  const dir = path.dirname(CONFIG_FILE);
  fs.mkdirSync(dir, { recursive: true });
  const tempFile = path.join(dir, `drive_config.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    fs.writeFileSync(tempFile, JSON.stringify(cleanConfig, null, 2), 'utf8');
    fs.renameSync(tempFile, CONFIG_FILE);
  } catch (ioErr) {
    try {
      if (fs.existsSync(tempFile)) {
        fs.unlinkSync(tempFile);
      }
    } catch (cleanErr) {
      console.warn('[GoogleDriveService] Không thể dọn tempFile:', cleanErr.message);
    }
    console.error('[GoogleDriveService] Lỗi lưu drive_config.json:', ioErr.message);
    throw new Error(`Không thể lưu cấu hình Google Drive: ${ioErr.message}`);
  }
}

/**
 * Tự động đồng bộ file PDF đã ký lên Google Drive của trường
 * @param {Object} doc Thông tin hồ sơ kế hoạch bài dạy
 * @param {string} pdfFilePathOrBase64 Đường dẫn file PDF hoặc chuỗi base64 đã ký số
 */
async function uploadToGoogleDrive(doc, pdfFilePathOrBase64) {
  const metadata = doc && typeof doc === 'object' ? doc : {};

  const dataUriPrefix = 'data:application/pdf;base64,';

  const decodeBase64Pdf = (rawStr, sourceLabel) => {
    if (typeof rawStr !== 'string') {
      throw new Error(`Dữ liệu ${sourceLabel} phải là chuỗi Base64.`);
    }
    const cleanStr = rawStr.replace(/\s+/g, '');
    if (cleanStr.length > Math.ceil(MAX_PDF_BYTES * 1.38)) {
      throw new Error(`Dung lượng ${sourceLabel} vượt quá giới hạn cho phép (35MB).`);
    }
    if (
      !cleanStr ||
      cleanStr.length % 4 !== 0 ||
      !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}\x3D\x3D|[A-Za-z0-9+/]{3}\x3D)?$/.test(cleanStr)
    ) {
      throw new Error(`Định dạng Base64 của ${sourceLabel} không hợp lệ.`);
    }
    const decoded = Buffer.from(cleanStr, 'base64');
    if (decoded.length > MAX_PDF_BYTES) {
      throw new Error(`Dung lượng ${sourceLabel} vượt quá giới hạn cho phép (35MB).`);
    }
    if (decoded.length < 5 || decoded.toString('utf8', 0, 5) !== '%PDF-') {
      throw new Error(`Dữ liệu ${sourceLabel} không phải là file PDF hợp lệ (%PDF- header missing).`);
    }
    return decoded;
  };

  let pdfBuffer = null;
  if (typeof pdfFilePathOrBase64 === 'string') {
    const trimmedInput = pdfFilePathOrBase64.trim();
    if (trimmedInput.slice(0, dataUriPrefix.length).toLowerCase() === dataUriPrefix) {
      const rawBase64 = trimmedInput.slice(dataUriPrefix.length);
      pdfBuffer = decodeBase64Pdf(rawBase64, 'Data URI PDF');
    } else if (trimmedInput.toLowerCase().endsWith('.pdf')) {
      const resolvedPath = path.resolve(trimmedInput);
      if (!fs.existsSync(resolvedPath)) {
        throw new Error('Đường dẫn cung cấp không tồn tại trên hệ thống.');
      }
      const canonicalPath = fs.realpathSync(resolvedPath);
      if (!isPathInsideAllowedRoot(canonicalPath, ALLOWED_DOCS_ROOT)) {
        throw new Error('Đường dẫn file PDF nằm ngoài phạm vi thư mục cho phép (Path Traversal Protection).');
      }
      let fd = null;
      try {
        fd = fs.openSync(canonicalPath, 'r');
        const stat = fs.fstatSync(fd);
        if (!stat.isFile()) {
          throw new Error('Đường dẫn cung cấp không phải là tệp hợp lệ.');
        }
        if (stat.size > MAX_PDF_BYTES) {
          throw new Error('Kích thước tệp PDF vượt quá giới hạn cho phép (35MB).');
        }
        const fileBuffer = Buffer.alloc(stat.size);
        const bytesRead = fs.readSync(fd, fileBuffer, 0, stat.size, 0);
        if (bytesRead < 5 || fileBuffer.toString('utf8', 0, 5) !== '%PDF-') {
          throw new Error('Tệp cung cấp không có định dạng PDF hợp lệ (%PDF- header missing).');
        }
        pdfBuffer = fileBuffer.subarray(0, bytesRead);
      } finally {
        if (fd !== null) {
          try {
            fs.closeSync(fd);
          } catch (closeErr) {
            console.warn('[GoogleDriveService] Không thể đóng file descriptor:', closeErr.message);
          }
        }
      }
    } else {
      const cleanStr = trimmedInput.replace(/\s+/g, '');
      if (
        cleanStr.length >= 20 &&
        cleanStr.length % 4 === 0 &&
        /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}\x3D\x3D|[A-Za-z0-9+/]{3}\x3D)?$/.test(cleanStr)
      ) {
        pdfBuffer = decodeBase64Pdf(cleanStr, 'Base64 PDF');
      }
    }
  }

  if (!metadata || typeof metadata !== 'object' || Array.isArray(metadata)) {
    throw new Error('Metadata hồ sơ không hợp lệ');
  }
  const meta = metadata;

  if (!pdfBuffer && typeof meta.fileBase64 === 'string' && meta.fileBase64.trim().length > 0) {
    const raw = meta.fileBase64.trim();
    const rawBase64 = raw.slice(0, dataUriPrefix.length).toLowerCase() === dataUriPrefix
      ? raw.slice(dataUriPrefix.length)
      : raw;
    pdfBuffer = decodeBase64Pdf(rawBase64, 'metadata.fileBase64');
  }

  if (!pdfBuffer || pdfBuffer.length === 0) {
    throw new Error('Dữ liệu file PDF ký số không hợp lệ để tải lên Google Drive');
  }

  const base64Content = pdfBuffer.toString('base64');

  const rawTitle = typeof meta.title === 'string' ? meta.title : (typeof meta.docTitle === 'string' ? meta.docTitle : '');
  const rawId = meta.id !== null && meta.id !== undefined ? String(meta.id) : (meta.docId !== null && meta.docId !== undefined ? String(meta.docId) : '');
  if (!rawTitle && !rawId) {
    throw new Error('Hồ sơ thiếu cả tiêu đề (title) và mã định danh (id).');
  }

  const teacherName = String(meta.authorName ?? meta.author ?? 'GiaoVien').trim() || 'GiaoVien';
  const schoolYear = String(meta.schoolYear ?? 'Năm học 2026 - 2027').trim() || 'Năm học 2026 - 2027';
  const safeDocTitle = (rawTitle || rawId).replace(/[^a-zA-Z0-9_\-\s]/g, '').trim() || 'TaiLieu';
  const safeDocId = rawId.replace(/[^a-zA-Z0-9_\-]/g, '').trim();
  const safeDept = String(meta.department || 'CVA').replace(/[^a-zA-Z0-9_\-]/g, '').trim() || 'CVA';

  const safeFileName = safeDocId 
    ? `[${safeDept}]_[${safeDocId}]_${safeDocTitle}_DaKy.pdf`
    : `[${safeDept}]_${safeDocTitle}_DaKy.pdf`;

  const safeSchoolYear = schoolYear.replace(/[^a-zA-Z0-9_\-\s]/g, '').trim() || 'NamHoc2026-2027';
  const safeTeacherFolder = teacherName.replace(/[^a-zA-Z0-9_\-\s]/g, '').trim() || 'GiaoVien';

  // Cấu trúc phân loại thư mục lưu trữ theo tên từng giáo viên
  const folderPath = `${safeSchoolYear} / ${safeTeacherFolder}`;

  // Thu thập danh sách email công vụ của các giáo viên tham gia ký
  let signerEmails = Array.isArray(meta.signerEmails) ? [...meta.signerEmails] : [];
  if (Array.isArray(meta.signatures)) {
    meta.signatures.forEach(sig => {
      if (sig && typeof sig.email === 'string' && !signerEmails.includes(sig.email)) {
        signerEmails.push(sig.email);
      }
    });
  }
  if (typeof meta.authorEmail === 'string' && !signerEmails.includes(meta.authorEmail)) {
    signerEmails.push(meta.authorEmail);
  }

  const config = getDriveConfig();

  // Nếu nhà trường đã cấu hình Google Apps Script Webhook URL thật
  // Trong môi trường kiểm thử (NODE_ENV=test), bắt buộc chạy simulation mode
  // để tránh ECONNRESET do fetch() chờ 60s tới GAS webhook ngoại mạng
  const isTestEnv = process.env.NODE_ENV === 'test';
  const safeMeta = (meta && typeof meta === 'object') ? meta : {};

  if (!isTestEnv && config.gasWebhookUrl && typeof config.gasWebhookUrl === 'string') {
    let webhookUrl;
    try {
      webhookUrl = new URL(config.gasWebhookUrl);
    } catch {
      throw new Error('Google Apps Script webhook URL không hợp lệ.');
    }
    if (!['https:'].includes(webhookUrl.protocol)) {
      throw new Error('Google Apps Script webhook phải sử dụng HTTPS');
    }

    console.log(`[Google Drive] Đang đẩy file lên Google Apps Script: ${webhookUrl.toString()}`);
    const payload = JSON.stringify({
      action: 'UPLOAD_SIGNED_DOC',
      fileName: safeFileName,
      folderPath: folderPath,
      schoolFolderId: config.schoolFolderId,
      secret_token: config.gasWebhookSecret,
      docId: safeDocId || rawTitle,
      title: rawTitle || 'Báo cáo chuyên môn',
      docTitle: rawTitle || 'Báo cáo chuyên môn',
      author: teacherName,
      department: safeDept,
      approver: String(safeMeta.approver || 'Ban Giám hiệu'),
      status: String(safeMeta.status || 'ĐÃ KÝ DUYỆT & ĐÓNG DẤU'),
      signerEmails: signerEmails,
      fileBase64: base64Content
    });

    const result = await sendHttpPost(webhookUrl.toString(), payload);
    if (result && (result.success === true || result.fileId)) {
      return {
        success: true,
        isRealCloud: true,
        fileId: result.fileId || `drive_${Date.now()}`,
        fileName: safeFileName,
        viewUrl: result.viewUrl || (result.fileId ? `https://drive.google.com/file/d/${result.fileId}/view` : `https://drive.google.com`),
        downloadUrl: result.downloadUrl || null,
        folderPath: result.folderPath || folderPath,
        uploadedAt: new Date().toISOString().replace('T', ' ').substring(0, 19),
        mode: 'REAL_GOOGLE_DRIVE',
        message: 'Đã lưu trữ thành công trên Google Drive đám mây của trường!'
      };
    } else {
      throw new Error((result && result.error) || (result && result.message) || 'Google Apps Script trả về lỗi không xác định');
    }
  }

  // Chế độ Mô phỏng / Lưu cục bộ khi CHƯA CẤU HÌNH Webhook Google Apps Script thật:
  const seed = String(safeDocId || rawTitle || 'doc') + String(Date.now());
  const fakeFileId = `1${Buffer.from(seed).toString('base64').replace(/[^a-zA-Z0-9]/g, '').substring(0, 28)}`;
  const driveViewUrl = `https://drive.google.com/file/d/${fakeFileId}/view?usp=sharing`;

  // Lưu một bản sao vào thư mục đồng bộ cục bộ của Google Drive Desktop theo từng giáo viên
  const localDriveDir = path.join(__dirname, 'GoogleDrive_KhoTruong', safeSchoolYear, safeTeacherFolder);
  await fs.promises.mkdir(localDriveDir, { recursive: true });

  const destPath = path.join(localDriveDir, safeFileName);
  const tempPath = path.join(localDriveDir, `${safeFileName}.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`);
  try {
    await fs.promises.writeFile(tempPath, pdfBuffer);
    await fs.promises.rename(tempPath, destPath);
  } catch (ioErr) {
    try {
      if (fs.existsSync(tempPath)) {
        await fs.promises.unlink(tempPath);
      }
    } catch (cleanErr) {
      console.warn('[GoogleDriveService] Không thể dọn tempPath:', cleanErr.message);
    }
    console.error('[GoogleDriveService] Lỗi ghi file mirror cục bộ:', ioErr.message);
    throw new Error(`Không thể ghi bản sao PDF cục bộ: ${ioErr.message}`);
  }

  return {
    success: true,
    isRealCloud: false,
    fileId: fakeFileId,
    fileName: safeFileName,
    viewUrl: driveViewUrl,
    folderPath: folderPath,
    localMirrorPath: destPath,
    uploadedAt: new Date().toISOString().replace('T', ' ').substring(0, 19),
    mode: 'SIMULATION_LOCAL_MIRROR',
    message: 'Lưu trữ tại thư mục cục bộ theo tên giáo viên (Google Drive)'
  };
}

function sanitizePathSegment(val, fallback = 'Chung') {
  if (typeof val !== 'string' && typeof val !== 'number') return fallback;
  const cleaned = String(val)
    .replace(/[\x00-\x1F\x7F]/g, '')
    .replace(/[/\\]+/g, '_')
    .replace(/\.{2,}/g, '.')
    .replace(/[^a-zA-Z0-9_\-\s\u00C0-\u1EF9]/g, '')
    .trim()
    .replace(/\s+/g, ' ');
  return cleaned.substring(0, 100) || fallback;
}

/**
 * Lấy liên kết thư mục Google Drive của từng giáo viên
 */
async function getTeacherFolder(teacherName, schoolYear = 'Năm học 2026 - 2027', email = '') {
  const config = getDriveConfig();
  const safeTeacherName = sanitizePathSegment(teacherName, 'GiaoVien');
  const safeSchoolYear = sanitizePathSegment(schoolYear, 'NamHoc2026-2027');
  const folderPath = `${safeSchoolYear} / ${safeTeacherName}`;

  const cleanEmail = typeof email === 'string' && email.includes('@') && email.length <= 150
    ? email.trim().toLowerCase()
    : '';

  const isTestEnv = process.env.NODE_ENV === 'test';
  if (!isTestEnv && config.gasWebhookUrl && typeof config.gasWebhookUrl === 'string') {
    let webhookUrl = null;
    try {
      webhookUrl = new URL(config.gasWebhookUrl);
    } catch (urlErr) {
      console.warn('[Google Drive] Webhook URL không hợp lệ:', urlErr.message);
    }
    if (webhookUrl && ['https:'].includes(webhookUrl.protocol)) {
      try {
        const payload = JSON.stringify({
          action: 'GET_TEACHER_FOLDER',
          teacherName: safeTeacherName,
          folderPath: folderPath,
          email: cleanEmail,
          schoolFolderId: config.schoolFolderId,
          secret_token: config.gasWebhookSecret
        });
        const result = await sendHttpPost(webhookUrl.toString(), payload);
        if (result && result.success) {
          return result;
        }
      } catch (e) {
        console.warn('[Google Drive] Lỗi gọi GAS GET_TEACHER_FOLDER:', e.message);
      }
    }
  }

  // Fallback: Tìm kiếm thư mục theo tên giáo viên trên Google Drive
  return {
    success: true,
    folderPath: folderPath,
    folderUrl: `https://drive.google.com/drive/search?q=${encodeURIComponent(safeTeacherName)}`,
    message: 'Thư mục Google Drive cá nhân của Thầy/Cô'
  };
}

async function sendHttpPost(urlStr, dataStr) {
  let parsedUrl;
  try {
    parsedUrl = new URL(urlStr);
    if (parsedUrl.protocol !== 'http:' && parsedUrl.protocol !== 'https:') {
      throw new Error('Giao thức phải là http hoặc https');
    }
  } catch (urlErr) {
    throw new Error(`Đường dẫn URL gửi yêu cầu không hợp lệ: ${urlErr.message}`);
  }

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 60000); // 60s timeout

  try {
    const res = await fetch(parsedUrl.toString(), {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json'
      },
      body: typeof dataStr === 'string' ? dataStr : JSON.stringify(dataStr || {}),
      redirect: 'follow', // RẤT QUAN TRỌNG: Google Apps Script luôn trả về HTTP 302 Redirect
      signal: controller.signal
    });

    const text = await res.text();
    let json = null;
    try {
      json = JSON.parse(text);
    } catch (parseErr) {
      json = { success: false, raw: text, error: `Phản hồi từ Google Apps Script không phải JSON hợp lệ: ${parseErr.message}`, parseError: parseErr.message };
    }

    if (!res.ok) {
      const errMsg = (json && (json.message || json.error)) || `HTTP_${res.status}`;
      return { success: false, status: res.status, error: errMsg, details: json };
    }

    return json;
  } catch (err) {
    if (err && err.name === 'AbortError') {
      throw new Error('Hết thời gian chờ kết nối Google Drive (Timeout 60s)');
    }
    throw err;
  } finally {
    clearTimeout(timeoutId);
  }
}

module.exports = {
  getDriveConfig,
  saveDriveConfig,
  uploadToGoogleDrive,
  getTeacherFolder
};

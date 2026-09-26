const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const zlib = require('zlib');
const { execFile } = require('child_process');
const { PDFDocument, rgb, StandardFonts } = require('pdf-lib');

/**
 * @notice [LOSSY PRESENTATION FALLBACK]: Chuyển đổi chuỗi sang WinAnsi ASCII phục vụ hiển thị trực quan dự phòng
 * cho pdf-lib (StandardFonts.Helvetica) khi không có fontkit/Unicode TrueType font nhúng.
 * Tuyệt đối không dùng cho băm mật mã hoặc đối chiếu danh tính pháp lý cốt lõi.
 */
function safeAscii(str, rejectOnDataLoss = false) {
  if (!str) return '';
  const inputStr = String(str);
  if (/^[\x20-\x7E]*$/.test(inputStr)) return inputStr;
  const converted = inputStr
    .normalize('NFD')
    .replace(/[\u0300-\u036f]/g, '')
    .replace(/đ/g, 'd')
    .replace(/Đ/g, 'D');
  if (rejectOnDataLoss && converted !== inputStr) {
    throw new Error(`[pdfSignerService safeAscii] Từ chối chuyển đổi: Phát hiện mất dữ liệu ký tự tiếng Việt (${inputStr} -> ${converted})`);
  }
  if (/[^\x20-\x7E]/.test(converted)) {
    throw new Error(`[pdfSignerService safeAscii] Ký tự không thể biểu diễn trong bảng mã ASCII/WinAnsi: ${JSON.stringify(str)}`);
  }
  return converted;
}

/**
 * Trả về danh sách thư mục gốc hợp lệ đã được canonicalize tuyệt đối qua realpathSync
 */
function getCanonicalAllowedRoots() {
  const candidates = [
    path.resolve(__dirname),
    path.resolve(os.tmpdir()),
    path.resolve(process.cwd())
  ];
  const roots = [];
  for (const c of candidates) {
    try {
      if (fs.existsSync(c)) {
        roots.push(fs.realpathSync(c));
      }
    } catch (e) {
      console.warn('[pdfSignerService getCanonicalAllowedRoots] Cảnh báo chuẩn hóa root:', e.message);
    }
  }
  return roots;
}

/**
 * Kiểm tra mọi phân đoạn của đường dẫn để đảm bảo không có symbolic link nào được chèn vào
 */
function verifyNoSymlinkInPath(fullPath) {
  const resolved = path.resolve(fullPath);
  let current = resolved;
  const parts = [];
  while (current && current !== path.dirname(current)) {
    parts.unshift(current);
    current = path.dirname(current);
  }
  for (const p of parts) {
    try {
      const lstat = fs.lstatSync(p);
      if (lstat.isSymbolicLink()) {
        throw new Error(`[pdfSignerService] Phát hiện symbolic link không an toàn trong đường dẫn: ${p}`);
      }
    } catch (err) {
      if (err && err.code === 'ENOENT') {
        continue;
      }
      throw err;
    }
  }
}

/**
 * Thẩm định và chuẩn hóa thư mục đầu ra trong phạm vi allowedRoots được cấp phép.
 * Từ chối đường dẫn ngoài canonicalRoots, chuẩn hóa thư mục và phát hiện symlink.
 */
function validateCanonicalOutputDir(outDir, allowedRoots) {
  if (!outDir || typeof outDir !== 'string') {
    throw new TypeError('[pdfSignerService] Thư mục đầu ra không hợp lệ.');
  }
  const isWin = process.platform === 'win32';
  const norm = (str) => (isWin ? str.toLowerCase() : str);
  const absDir = path.resolve(outDir);
  const canonicalRoots = (Array.isArray(allowedRoots) && allowedRoots.length > 0)
    ? allowedRoots.map((r) => fs.realpathSync(r))
    : getCanonicalAllowedRoots();
  const matchedRoot = canonicalRoots.find((r) => norm(absDir) === norm(r) || norm(absDir).startsWith(norm(r) + path.sep));
  if (!matchedRoot) {
    throw new Error(`[pdfSignerService] Thư mục đích nằm ngoài phạm vi được cấp phép: ${absDir}`);
  }
  if (!fs.existsSync(absDir)) {
    fs.mkdirSync(absDir, { recursive: true });
  }
  const realDir = fs.realpathSync(absDir);
  const matchedReal = canonicalRoots.find((r) => norm(realDir) === norm(r) || norm(realDir).startsWith(norm(r) + path.sep));
  if (!matchedReal) {
    throw new Error(`[pdfSignerService] Thư mục thực tế sau khi chuẩn hóa nằm ngoài phạm vi: ${realDir}`);
  }
  if (!fs.statSync(realDir).isDirectory()) {
    throw new Error(`[pdfSignerService] Đường dẫn đầu ra không phải là thư mục: ${realDir}`);
  }
  verifyNoSymlinkInPath(realDir);
  return { realDir, canonicalRoots };
}

/**
 * Ghi chú an toàn Tier 2 (Standard Web Application Service):
 * - validateCanonicalOutputDir từ chối đường dẫn ngoài canonicalRoots và phát hiện symlink.
 * - Thao tác ghi PDF sử dụng tệp tạm độc quyền trong realDir kết hợp hoán đổi nguyên tử.
 */

// --- HẾT LÁT CẮT 2: BẢO VỆ ĐƯỜNG DẪN VÀ THẨM ĐỊNH THƯ MỤC XUẤT CANONICAL ---
// ============================================================================
/**
 * Cam kết tệp PDF nguyên tử qua tệp tạm độc quyền 'wx', fsyncSync và atomic rename.
 * Thẩm định sanity check header/trailer, cấu trúc PDFDocument không mã hóa và đối soát mã băm SHA-256.
 */
async function safelyCommitPdfOutput(stagedPdfPath, targetOutputPath, allowedRoots) {
  if (!stagedPdfPath || typeof stagedPdfPath !== 'string' || !targetOutputPath || typeof targetOutputPath !== 'string') {
    throw new TypeError('[pdfSignerService safelyCommitPdfOutput] Đường dẫn đầu vào hoặc đầu ra không hợp lệ.');
  }
  const absPdf = path.resolve(targetOutputPath);
  const outDir = path.dirname(absPdf);
  const { realDir, canonicalRoots } = validateCanonicalOutputDir(outDir, allowedRoots);
  verifyNoSymlinkInPath(absPdf); verifyNoSymlinkInPath(stagedPdfPath);
  const stagedStat = fs.statSync(stagedPdfPath);
  if (!stagedStat.isFile() || stagedStat.size < 100) {
    throw new Error('[pdfSignerService safelyCommitPdfOutput] File PDF đầu ra rỗng hoặc quá nhỏ (< 100 bytes).');
  }
  const stagedContent = fs.readFileSync(stagedPdfPath);
  const head = stagedContent.subarray(0, 10).toString('ascii');
  if (!head.startsWith('%PDF-')) {
    throw new Error('[pdfSignerService safelyCommitPdfOutput] File đầu ra không chứa magic bytes %PDF- hợp lệ.');
  }
  const tail = stagedContent.subarray(Math.max(0, stagedContent.length - 1024)).toString('latin1');
  if (!tail.includes('%%EOF')) {
    throw new Error('[pdfSignerService safelyCommitPdfOutput] File đầu ra thiếu trailer %%EOF.');
  }
  try {
    await PDFDocument.load(stagedContent);
  } catch (pdfErr) {
    throw new Error(`[pdfSignerService safelyCommitPdfOutput] File PDF đầu ra bị lỗi cấu trúc hoặc mã hóa: ${pdfErr.message}`);
  }
  const stagedSha256 = crypto.createHash('sha256').update(stagedContent).digest('hex');
  const tempOutput = path.join(realDir, `.tmp_conv_${crypto.randomUUID()}.pdf`);
  const tempFd = fs.openSync(tempOutput, 'wx', 0o600);
  let committed = false; let fdClosed = false;
  try {
    fs.writeSync(tempFd, stagedContent, 0, stagedContent.length);
    fs.fsyncSync(tempFd);
    fs.closeSync(tempFd); fdClosed = true;
    fs.renameSync(tempOutput, absPdf); committed = true;
  } finally {
    if (!fdClosed) { try { fs.closeSync(tempFd); } catch (cErr) { console.warn('[pdfSignerService] Lỗi đóng tempFd:', cErr.message); } }
    if (!committed) { try { if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput); } catch (uErr) { console.warn('[pdfSignerService] Lỗi dọn tệp tạm:', uErr.message); } }
  }
  const postReal = fs.realpathSync(absPdf);
  const isWin = process.platform === 'win32'; const norm = (s) => (isWin ? s.toLowerCase() : s);
  const isPostAllowed = canonicalRoots.some((r) => norm(postReal) === norm(r) || norm(postReal).startsWith(norm(r) + path.sep));
  if (!isPostAllowed || fs.lstatSync(absPdf).isSymbolicLink()) {
    try { fs.unlinkSync(absPdf); } catch (uErr) { console.warn('[pdfSignerService] Lỗi xóa file vi phạm:', uErr.message); }
    throw new Error('[pdfSignerService safelyCommitPdfOutput] Hậu kiểm tra tính hợp lệ file đích thất bại.');
  }
  const committedSha256 = crypto.createHash('sha256').update(fs.readFileSync(absPdf)).digest('hex');
  if (committedSha256 !== stagedSha256) {
    try { fs.unlinkSync(absPdf); } catch (uErr) { console.warn('[pdfSignerService] Lỗi xóa file sai hash:', uErr.message); }
    throw new Error('[pdfSignerService safelyCommitPdfOutput] Phát hiện sai lệch mã băm artifact sau khi commit.');
  }
  return absPdf;
}
// --- HẾT LÁT CẮT 3: CAM KẾT NGUYÊN TỬ TỆP PDF AN TOÀN VÀ ĐỐI SOÁT SHA-256 ---

// ============================================================================

/**
 * Chuyển đổi tệp Microsoft Word (.docx / .doc) sang PDF bằng Word COM Automation (Windows) hoặc LibreOffice (Linux/Cloud).
 * Đảm bảo tính nguyên tử, thư mục cô lập per-request, giới hạn kích thước 35MB và loại bỏ TOCTOU.
 */
function convertDocxToPdf(docxPath, outputPath) {
  return new Promise((resolve, reject) => {
    if (!docxPath || typeof docxPath !== 'string' || !outputPath || typeof outputPath !== 'string') {
      return reject(new TypeError('[pdfSignerService convertDocxToPdf] Đường dẫn đầu vào hoặc đầu ra không hợp lệ.'));
    }
    const allowedRoots = getCanonicalAllowedRoots();
    const absDocx = path.resolve(docxPath); const absPdf = path.resolve(outputPath);
    const isWin = process.platform === 'win32'; const norm = (s) => (isWin ? s.toLowerCase() : s);
    const isAllowed = (p) => allowedRoots.some((r) => norm(p) === norm(r) || norm(p).startsWith(norm(r) + path.sep));
    let realDocx;
    try {
      validateCanonicalOutputDir(path.dirname(absPdf), allowedRoots);
      verifyNoSymlinkInPath(absPdf); verifyNoSymlinkInPath(absDocx);
      if (fs.existsSync(absPdf) && fs.lstatSync(absPdf).isSymbolicLink()) {
        return reject(new Error('[pdfSignerService convertDocxToPdf] Tệp đích là symlink không hợp lệ.'));
      }
      realDocx = fs.realpathSync(absDocx);
      if (!isAllowed(realDocx)) return reject(new Error('[pdfSignerService convertDocxToPdf] Tệp nguồn ngoài phạm vi cấp phép.'));
    } catch (pathErr) { return reject(pathErr); }
    const ext = path.extname(realDocx).toLowerCase();
    if (ext !== '.doc' && ext !== '.docx') {
      return reject(new Error('[pdfSignerService convertDocxToPdf] Chỉ hỗ trợ định dạng Word .doc hoặc .docx.'));
    }
    let sourceBuffer;
    try {
      const fd = fs.openSync(realDocx, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
      try {
        const fstat = fs.fstatSync(fd);
        if (!fstat.isFile()) return reject(new Error('[pdfSignerService convertDocxToPdf] Tệp nguồn không phải tệp thường.'));
        if (fstat.size === 0) return reject(new Error('[pdfSignerService convertDocxToPdf] Tệp Word nguồn rỗng (0 bytes).'));
        const MAX_DOCX_SIZE = 35 * 1024 * 1024; // 35MB Stream Guard Limit
        if (fstat.size > MAX_DOCX_SIZE) return reject(new Error('[pdfSignerService convertDocxToPdf] Tệp Word vượt 35MB.'));
        if (!isWin && fs.existsSync(`/proc/self/fd/${fd}`)) {
          const procPath = fs.realpathSync(`/proc/self/fd/${fd}`);
          if (!isAllowed(procPath)) return reject(new Error('[pdfSignerService convertDocxToPdf] Descriptor ngoài phạm vi cấp phép.'));
        }
        sourceBuffer = Buffer.alloc(fstat.size);
        let totalRead = 0;
        while (totalRead < fstat.size) {
          const bytes = fs.readSync(fd, sourceBuffer, totalRead, fstat.size - totalRead, totalRead);
          if (bytes === 0) break;
          totalRead += bytes;
        }
        if (totalRead !== fstat.size) return reject(new Error('[pdfSignerService convertDocxToPdf] Đọc không đủ byte từ tệp nguồn.'));
      } finally { try { fs.closeSync(fd); } catch (cErr) { console.warn('[pdfSignerService] Lỗi đóng fd:', cErr.message); } }
    } catch (openErr) { return reject(new Error('[pdfSignerService convertDocxToPdf] Lỗi mở tệp: ' + openErr.message)); }
    let isolatedTmpDir;
    try {
      isolatedTmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'edusign_conv_'));
    } catch (tmpErr) { return reject(new Error('[pdfSignerService convertDocxToPdf] Lỗi tạo thư mục tạm: ' + tmpErr.message)); }
    const uniqueName = `doc_${crypto.randomUUID()}`;
    const stagedDocx = path.join(isolatedTmpDir, `${uniqueName}${ext}`); const stagedPdf = path.join(isolatedTmpDir, `${uniqueName}.pdf`);
    const cleanupTemp = () => { try { if (fs.existsSync(isolatedTmpDir)) fs.rmSync(isolatedTmpDir, { recursive: true, force: true }); } catch (cErr) { console.warn('[pdfSignerService] Lỗi dọn tạm:', cErr.message); } };
    // Ghi an toàn bản sao độc quyền (wx) vào thư mục tạm cô lập
    // ============================================================================
    try {
      fs.writeFileSync(stagedDocx, sourceBuffer, { mode: 0o600, flag: 'wx' });
    } catch (writeErr) {
      cleanupTemp();
      return reject(new Error(`[pdfSignerService convertDocxToPdf] Không thể ghi bản sao tạm tệp Word: ${writeErr.message}`));
    }

    // Môi trường phi Windows (Linux / Container)
    if (process.platform !== 'win32') {
      const args = ['--headless', '--convert-to', 'pdf', '--outdir', isolatedTmpDir, stagedDocx];
      execFile('soffice', args, { timeout: 45000 }, (soErr) => {
        if (soErr) {
          execFile('libreoffice', args, { timeout: 45000 }, (loErr) => {
            if (loErr) {
              cleanupTemp();
              return reject(new Error('Máy chủ Linux Cloud (Render) không có Word COM hoặc LibreOffice. Hệ thống sẽ tự động chuyển đổi trực tiếp trên trình duyệt.'));
            }
            finishConversion();
          });
          return;
        }
        finishConversion();
      });

      function finishConversion() {
        if (!fs.existsSync(stagedPdf)) {
          cleanupTemp();
          return reject(new Error('[pdfSignerService convertDocxToPdf] Tiến trình LibreOffice không tạo được file PDF đầu ra.'));
        }
        safelyCommitPdfOutput(stagedPdf, absPdf, allowedRoots)
          .then((finalPdf) => {
            cleanupTemp();
            resolve(finalPdf);
          })
          .catch((postErr) => {
            cleanupTemp();
            reject(new Error(`[pdfSignerService convertDocxToPdf] Lỗi hoàn tất file PDF: ${postErr.message}`));
          });
      }
      return;
    }

    // Môi trường Windows: Sử dụng PowerShell gọi Word COM
    const tempPs1 = path.join(isolatedTmpDir, `${uniqueName}.ps1`);
    const script = '\uFEFF' + [
      `$w = New-Object -ComObject Word.Application`,
      `$w.Visible = $false`,
      `$w.DisplayAlerts = 0`,
      `try {`,
      `  $doc = $w.Documents.Open('${stagedDocx.replace(/'/g, "''")}')`,
      `  $doc.SaveAs([ref]'${stagedPdf.replace(/'/g, "''")}', [ref]17)`,
      `  $doc.Close([ref]0)`,
      `  Write-Output "SUCCESS"`,
      `} catch {`,
      `  Write-Error $_.Exception.Message`,
      `} finally {`,
      `  $w.Quit()`,
      `}`
    ].join('\r\n');

    try {
      fs.writeFileSync(tempPs1, script, 'utf8');
    } catch (psWriteErr) {
      cleanupTemp();
      return reject(new Error(`[pdfSignerService convertDocxToPdf] Không thể tạo script chuyển đổi: ${psWriteErr.message}`));
    }
    execFile('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', tempPs1], { timeout: 45000 }, (error, stdout, stderr) => {
      if (error || !fs.existsSync(stagedPdf)) {
        const errMsg = stderr || error?.message || 'File PDF đầu ra không được tạo.';
        cleanupTemp();
        return reject(new Error(`Chuyển đổi Word sang PDF không thành công: ${errMsg}`));
      }
      safelyCommitPdfOutput(stagedPdf, absPdf, allowedRoots)
        .then((finalPdf) => { cleanupTemp(); resolve(finalPdf); })
        .catch((commitErr) => { cleanupTemp(); reject(new Error('Không thể lưu PDF: ' + commitErr.message)); });
    });
  });
}

function isImageMagic(b) {
  if (!b || b.length < 8) return false;
  if (b[0] === 0x89 && b[1] === 0x50 && b[2] === 0x4e && b[3] === 0x47) return true;
  if (b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff) return true;
  return b.length >= 12 && b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP';
}
/**
 * Chuyển đổi dữ liệu ảnh (Base64 URI hoặc tệp trong uploads/public) thành Buffer.
 * Chống Path Traversal, loại bỏ __dirname, validate Base64/Magic bytes và chống TOCTOU fd.
 */
function resolveImageBuffer(imgDataOrPath) {
  if (!imgDataOrPath) return null;
  if (Buffer.isBuffer(imgDataOrPath)) return (imgDataOrPath.length <= 10 * 1024 * 1024 && isImageMagic(imgDataOrPath)) ? imgDataOrPath : null;
  if (typeof imgDataOrPath !== 'string') return null;
  const b64 = imgDataOrPath.match(/^data:image\/(png|jpeg|jpg|webp);base64,([A-Za-z0-9+/=\s]+)$/);
  if (b64) {
    const raw = b64[2].replace(/\s/g, '');
    if (raw.length > 15 * 1024 * 1024) return null;
    try { const buf = Buffer.from(raw, 'base64'); return (buf.length <= 10 * 1024 * 1024 && isImageMagic(buf)) ? buf : null; } catch (e) { return null; }
  }
  let candidate = imgDataOrPath.trim();
  if (candidate.startsWith('/uploads/') || candidate.startsWith('uploads/')) candidate = path.join(__dirname, 'uploads', candidate.replace(/^\/?uploads\/?/, ''));
  else if (candidate.startsWith('/public/') || candidate.startsWith('public/')) candidate = path.join(__dirname, 'public', candidate.replace(/^\/?public\/?/, ''));
  else if (!path.isAbsolute(candidate)) candidate = path.resolve(__dirname, 'uploads', candidate);
  let fd = null;
  try {
    const absPath = path.resolve(candidate);
    const realFile = fs.realpathSync(absPath);
    verifyNoSymlinkInPath(absPath);
    const allowed = [path.resolve(__dirname, 'uploads'), path.resolve(__dirname, 'public')];
    const canonicalRoots = allowed.map((r) => { try { return fs.realpathSync(r); } catch (e) { return null; } }).filter(Boolean);
    const isContained = canonicalRoots.some((r) => { const rel = path.relative(r, realFile); return !rel.startsWith('..') && !path.isAbsolute(rel); });
    if (!isContained) return null;
    fd = fs.openSync(realFile, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
    const stat = fs.fstatSync(fd);
    if (!stat.isFile() || stat.size === 0 || stat.size > 10 * 1024 * 1024) { fs.closeSync(fd); return null; }
    const buf = fs.readFileSync(fd);
    fs.closeSync(fd); fd = null;
    return isImageMagic(buf) ? buf : null;
  } catch (err) { if (fd !== null) { try { fs.closeSync(fd); } catch (e) { /* ignore */ } } return null; }
}

/**
 * Kiểm tra tính toàn vẹn của tệp PNG (IDAT chunks) trước khi đưa vào UPNG của pdf-lib
 * Ngăn chặn DoS ReDoS và Zip Bomb với giới hạn IDAT 10MB và maxOutputLength 20MB.
 */
function isSafePng(buf) {
  if (!buf || !Buffer.isBuffer(buf) || buf.length < 8 || buf.length > 10 * 1024 * 1024) return false;
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47) return false;
  try {
    let offset = 8;
    let totalIdat = 0;
    const idatChunks = [];
    while (offset + 8 <= buf.length) {
      const len = buf.readUInt32BE(offset);
      const type = buf.toString('ascii', offset + 4, offset + 8);
      if (offset + 12 + len > buf.length) return false;
      if (type === 'IDAT') {
        totalIdat += len;
        if (totalIdat > 10 * 1024 * 1024) return false;
        idatChunks.push(buf.slice(offset + 8, offset + 8 + len));
      }
      offset += 12 + len;
    }
    if (idatChunks.length === 0) return false;
    const allIdat = Buffer.concat(idatChunks);
    const zlib = require('zlib');
    zlib.inflateSync(allIdat, { maxOutputLength: 20 * 1024 * 1024 });
    return true;
  } catch (e) { return false; }
}

/**
 * Nhúng ảnh (PNG hoặc JPG) an toàn vào tài liệu PDF với giới hạn kích thước 10MB
 */
async function embedImageToPdf(pdfDoc, imgBuffer) {
  if (!pdfDoc || !imgBuffer || !Buffer.isBuffer(imgBuffer) || imgBuffer.length === 0 || imgBuffer.length > 10 * 1024 * 1024) return null;
  try {
    if (isSafePng(imgBuffer)) {
      return await pdfDoc.embedPng(imgBuffer);
    }
  } catch (ePng) {
    console.warn('[embedImageToPdf] Lỗi nhúng PNG:', ePng.message);
  }
  try {
    return await pdfDoc.embedJpg(imgBuffer);
  } catch (eJpg) {
    console.warn('[embedImageToPdf] Không thể nhúng ảnh vào PDF:', eJpg.message);
    return null;
  }
}

const { resolveFilePath } = require('./dataStore');
/**
 * Đóng dấu ảnh chữ ký & chứng nhận điện tử vào tệp PDF
 */
async function generateSignedPdf(doc) {
  if (!doc || typeof doc !== 'object') throw new TypeError('[generateSignedPdf] doc không hợp lệ.');
  let sourcePdfBuffer = null;
  // 0. Nếu đã có dữ liệu PDF ký số thật dạng Base64 lưu trong doc, ưu tiên dùng
  if (doc.signedPdfBase64 && typeof doc.signedPdfBase64 === 'string') {
    try {
      const cleanSignedB64 = (doc.signedPdfBase64 || '').replace(/^data:[^;]+;base64,/, '');
      if (cleanSignedB64.length <= 50 * 1024 * 1024 && /^[A-Za-z0-9+/=\s]+$/.test(cleanSignedB64)) {
        const buf = Buffer.from(cleanSignedB64, 'base64');
        if (buf.length > 50 && buf.length <= 35 * 1024 * 1024 && buf.toString('ascii', 0, 5).startsWith('%PDF')) sourcePdfBuffer = buf;
      }
    } catch (e) { console.warn('[generateSignedPdf] Cảnh báo nạp signedPdfBase64:', e.message); }
  }

  // 1. Đọc file nguồn từ fileBase64 nếu có (giới hạn 35MB và xác thực magic bytes Word/PDF)
  if (!sourcePdfBuffer && doc.fileBase64 && typeof doc.fileBase64 === 'string') {
    try {
      const cleanB64 = doc.fileBase64.replace(/^data:[^;]+;base64,/, '');
      if (cleanB64.length <= 50 * 1024 * 1024 && /^[A-Za-z0-9+/=\s]+$/.test(cleanB64)) {
        const buf = Buffer.from(cleanB64, 'base64'); if (buf.length > 50 && buf.length <= 35 * 1024 * 1024) {
          if (buf.toString('ascii', 0, 5).startsWith('%PDF')) sourcePdfBuffer = buf;
          else if ((doc.fileName || '').match(/\.(docx|doc)$/i)) {
            const isWord = (buf[0] === 0x50 && buf[1] === 0x4b && buf[2] === 0x03 && buf[3] === 0x04) || (buf[0] === 0xd0 && buf[1] === 0xcf && buf[2] === 0x11 && buf[3] === 0xe0);
            if (isWord) {
              let tempDir = null; try {
                const os = require('os');
                tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cva_conv_'));
                const ext = (doc.fileName || '').toLowerCase().endsWith('.doc') ? '.doc' : '.docx';
                const tempDocx = path.join(tempDir, `input${ext}`);
                const tempPdf = path.join(tempDir, 'output.pdf');
                fs.writeFileSync(tempDocx, buf, { flag: 'wx' }); await convertDocxToPdf(tempDocx, tempPdf);
                const pStat = fs.existsSync(tempPdf) ? fs.statSync(tempPdf) : null;
                if (pStat && pStat.size > 100 && pStat.size <= 35 * 1024 * 1024) {
                  const cBuf = fs.readFileSync(tempPdf); if (cBuf.toString('ascii', 0, 5).startsWith('%PDF')) sourcePdfBuffer = cBuf;
                }
              } catch (convErr) {
                console.warn('Word COM conversion note:', convErr.message); if (doc.onlyConvert) throw convErr;
              } finally {
                if (tempDir) { try { fs.rmSync(tempDir, { recursive: true, force: true }); } catch (e) { void e; } }
              }
            }
          }
        }
      }
    } catch (err) { console.error('Lỗi đọc fileBase64 trong generateSignedPdf:', err.message); if (doc.onlyConvert) throw err; }
  }

  // 2. Đọc file nguồn từ realSignedPath nếu có (hỗ trợ cả Windows và Linux)
  if (!sourcePdfBuffer && doc.realSignedPath) {
    const res = resolveFilePath(doc.realSignedPath);
    if (res && fs.existsSync(res)) {
      try {
        const st = fs.statSync(res);
        if (st.isFile() && st.size > 50 && st.size <= 35 * 1024 * 1024) {
          const sBuf = fs.readFileSync(res); if (sBuf.toString('ascii', 0, 5).startsWith('%PDF')) sourcePdfBuffer = sBuf;
        }
      } catch (e) { console.warn('[generateSignedPdf] Cảnh báo đọc realSignedPath:', e.message); }
    }
  }

  // 3. Đọc file nguồn từ filePath nếu chưa có (hỗ trợ cả Windows và Linux)
  if (!sourcePdfBuffer && doc.filePath) {
    const resolvedPath = resolveFilePath(doc.filePath);
    if (resolvedPath && fs.existsSync(resolvedPath)) {
      const ext = path.extname(resolvedPath).toLowerCase();
      if (ext === '.pdf') {
        try {
          const s = fs.statSync(resolvedPath);
          if (!s.isFile() || s.size < 50 || s.size > 35 * 1024 * 1024) throw new Error('Kích thước PDF không hợp lệ.');
          const b = fs.readFileSync(resolvedPath);
          if (!b.toString('ascii', 0, 5).startsWith('%PDF')) throw new Error('Tệp không đúng định dạng PDF.');
          sourcePdfBuffer = b;
        } catch (err) { throw new Error(`[generateSignedPdf] Lỗi đọc file gốc PDF: ${err.message}`); }
      } else if (ext === '.docx' || ext === '.doc') {
        let tempDir = null;
        try {
          tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cva_wconv_'));
          const tempPdf = path.join(tempDir, 'output.pdf');
          await convertDocxToPdf(resolvedPath, tempPdf);
          const st = fs.existsSync(tempPdf) ? fs.statSync(tempPdf) : null;
          if (!st || !st.isFile() || st.size < 50 || st.size > 35 * 1024 * 1024) {
            throw new Error('Kích thước PDF sau chuyển đổi không hợp lệ.');
          }
          const b = fs.readFileSync(tempPdf);
          if (!b.toString('ascii', 0, 5).startsWith('%PDF')) throw new Error('PDF thiếu magic bytes %PDF.');
          sourcePdfBuffer = b;
        } catch (e) {
          throw new Error(`[generateSignedPdf] Lỗi chuyển đổi Word sang PDF khi ký: ${e.message}`);
        } finally {
          if (tempDir) {
            try { fs.rmSync(tempDir, { recursive: true, force: true }); }
            catch (rmErr) { console.warn('[generateSignedPdf] Không thể dọn thư mục tạm:', rmErr.message); }
          }
        }
      }
    }
  }

  // Nếu chỉ yêu cầu chuyển đổi định dạng (chưa ký, chưa đóng dấu ảnh), trả về trực tiếp file PDF
  if (doc.onlyConvert) {
    if (sourcePdfBuffer && sourcePdfBuffer.length > 50) return sourcePdfBuffer;
    throw new Error('Chuyển đổi Word sang PDF không thành công, vui lòng kiểm tra tệp Word.');
  }

  // Nếu tài liệu đã được đóng dấu ảnh từ trước (isPreStamped), không đóng dấu lặp lại
  if (doc.isPreStamped && sourcePdfBuffer && sourcePdfBuffer.length > 50) return sourcePdfBuffer;

  // Bảo vệ chữ ký số đã có trước: Dò marker trên Buffer, giữ nguyên cho ký nối tiếp
  if (sourcePdfBuffer && sourcePdfBuffer.length > 50) {
    const hasSig = sourcePdfBuffer.includes('/ByteRange') || sourcePdfBuffer.includes('/Type /Sig') || sourcePdfBuffer.includes('/Type/Sig');
    if (hasSig) {
      console.log('[Signature Preservation] 🛡️ Phát hiện tệp PDF có chữ ký số; giữ buffer làm đầu vào cho ký nối tiếp.');
      if (doc.preserveExistingOnly === true) return sourcePdfBuffer;
    }
  }

  // Không fallback sang PDF rỗng nếu đã chỉ định nguồn tệp nhưng không đọc được
  const hasSpecifiedSource = !!(doc.signedPdfBase64 || doc.fileBase64 || doc.realSignedPath || doc.filePath);
  if (!sourcePdfBuffer || sourcePdfBuffer.length < 50 || !sourcePdfBuffer.toString('ascii', 0, 5).startsWith('%PDF')) {
    if (hasSpecifiedSource) throw new Error('[generateSignedPdf] Tài liệu nguồn được cung cấp không hợp lệ hoặc bị lỗi.');
    const newEmptyDoc = await PDFDocument.create();
    const page = newEmptyDoc.addPage([595.28, 841.89]); // Khổ chuẩn A4 (595 x 842 pt)
    const helveticaBold = await newEmptyDoc.embedFont(StandardFonts.HelveticaBold);
    const helvetica = await newEmptyDoc.embedFont(StandardFonts.Helvetica);

    const docTitleAscii = safeAscii(doc.title || 'KE HOACH BAI DAY').toUpperCase();
    const docAuthorAscii = safeAscii(doc.author || 'Hà Văn Tý');
    const docDeptAscii = safeAscii(doc.department || 'Tổ Toán - Tin');
    const docWeekAscii = safeAscii(doc.week || 'Tuần 12');
    const docGradeAscii = safeAscii(doc.grade || 'Khối 9');
    const docIdText = safeAscii(doc.id || 'KHBD-2026');

    page.drawText('TRUONG THCS CHU VAN AN', { x: 50, y: 790, size: 12, font: helveticaBold, color: rgb(0.1, 0.2, 0.4) });
    page.drawText(`${docDeptAscii.toUpperCase()}`, { x: 50, y: 775, size: 10, font: helvetica, color: rgb(0.3, 0.3, 0.3) });
    page.drawText(`Ma ho so: ${docIdText}`, { x: 400, y: 790, size: 10, font: helvetica, color: rgb(0.4, 0.4, 0.4) });

    page.drawLine({ start: { x: 50, y: 760 }, end: { x: 545, y: 760 }, thickness: 1.5, color: rgb(0.2, 0.4, 0.8) });

    page.drawText(docTitleAscii.substring(0, 55), { x: 50, y: 720, size: 14, font: helveticaBold, color: rgb(0.08, 0.12, 0.2) });
    page.drawText(`Giao vien thuc hien: ${docAuthorAscii}`, { x: 50, y: 690, size: 11, font: helveticaBold, color: rgb(0.2, 0.2, 0.2) });
    page.drawText(`Phan phoi chuong trinh: ${docWeekAscii} - ${docGradeAscii}`, { x: 50, y: 670, size: 11, font: helvetica, color: rgb(0.3, 0.3, 0.3) });
    page.drawText(`Ngay khoi tao: ${doc.createdAt || new Date().toISOString().substring(0, 10)}`, { x: 50, y: 650, size: 10, font: helvetica, color: rgb(0.4, 0.4, 0.4) });

    const isCopyForPlaceholder = (doc.signType === 'COPY' || doc.isCopySign === true);
    if (isCopyForPlaceholder) {
      page.drawText('HO SO CHUNG THUC BAN SAO DIEN TU', { x: 50, y: 320, size: 11, font: helveticaBold, color: rgb(0.1, 0.3, 0.6) });
      page.drawText(`Hinh thuc: ${safeAscii(doc.copyType || 'SAO Y')} (Nghi dinh 30/2020/ND-CP)`, { x: 50, y: 295, size: 10, font: helvetica, color: rgb(0.2, 0.2, 0.2) });
      page.drawText('Don vi chung thuc: TRUONG THCS CHU VAN AN', { x: 50, y: 275, size: 10, font: helvetica, color: rgb(0.3, 0.3, 0.3) });
      page.drawText('Ghi chu: Ban sao dien tu duoc chung thuc bang chu ky so o goc tren ben phai theo quy dinh.', { x: 50, y: 255, size: 9, font: helvetica, color: rgb(0.4, 0.4, 0.4) });
    } else {
      page.drawText('XAC NHAN KY DUYET GIAO AN DIEN TU', { x: 50, y: 320, size: 11, font: helveticaBold, color: rgb(0.1, 0.3, 0.6) });
      page.drawText('GIAO VIEN SOAN THAO', { x: 400, y: 290, size: 10, font: helveticaBold, color: rgb(0.2, 0.2, 0.2) });
      page.drawText(docAuthorAscii, { x: 400, y: 190, size: 10, font: helveticaBold, color: rgb(0.1, 0.1, 0.1) });
    }

    sourcePdfBuffer = await newEmptyDoc.save();
  }

  // 3. Nạp PDF bằng pdf-lib để đóng dấu ảnh chữ ký trực quan
  const pdfDoc = await PDFDocument.load(sourcePdfBuffer);
  const sourcePages = pdfDoc.getPages();
  if (sourcePages.length > 0) {
    const isCopySign = (doc.signType === 'COPY' || doc.isCopySign === true);
    if (isCopySign) {
      const copyType = doc.copyType || 'SAO Y';
      const signerName = (doc.signatures && doc.signatures[0] && doc.signatures[0].signerName) || doc.author || 'Hà Văn Tý';
      const nowIso = new Date().toISOString();
      const copyText = doc.copyText || `${copyType}; ${signerName}; Thời gian ký: ${nowIso}`;
      const firstPage = sourcePages[0];
      const { width: p1W, height: p1H } = firstPage.getSize();
      // 1. Nếu có ảnh banner PNG từ client (Canvas 300 DPI hiển thị tiếng Việt hoàn hảo)
      let bannerDrawn = false;
      const bannerB64 = doc.copySignBannerBase64 || doc.copyBannerBase64;
      if (bannerB64 && typeof bannerB64 === 'string' && bannerB64.length <= 15 * 1024 * 1024) {
        try {
          const rawB64 = bannerB64.replace(/^data:[^;]+;base64,/, '');
          if (/^[A-Za-z0-9+/=\s]+$/.test(rawB64)) {
            const bannerBuf = Buffer.from(rawB64, 'base64');
            if (bannerBuf.length >= 50 && bannerBuf.length <= 10 * 1024 * 1024 && isSafePng(bannerBuf)) {
              const bannerPng = await pdfDoc.embedPng(bannerBuf);
              const rawW = Number(doc.copySignBannerWidthPt);
              const rawH = Number(doc.copySignBannerHeightPt);
              const defW = Math.min(Math.round(bannerPng.width / 3.0), p1W - 80);
              const defH = Math.min(Math.round(bannerPng.height / 3.0), p1H - 80);
              const wPt = (Number.isFinite(rawW) && rawW >= 10 && rawW <= p1W - 40) ? rawW : defW;
              const hPt = (Number.isFinite(rawH) && rawH >= 5 && rawH <= p1H - 40) ? rawH : defH;
              const textX = p1W - wPt - 40;
              const textY = p1H - hPt - 18;
              firstPage.drawImage(bannerPng, {
                x: textX,
                y: textY,
                width: wPt,
                height: hPt
              });
              bannerDrawn = true;
              console.log(`[Copy Sign] 📋 Đã nhúng ảnh chữ ký Sao y chuẩn Canvas PNG tại Trang 1 (${textX.toFixed(1)}, ${textY.toFixed(1)}, W=${wPt}, H=${hPt}): "${copyText}"`);
            }
          }
        } catch (bannerErr) {
          console.warn('[Copy Sign] Lỗi nhúng ảnh banner PNG:', bannerErr.message);
        }
      }

      // 2. Fallback: Nếu chưa có ảnh Canvas, in dòng text chuẩn an toàn (loại bỏ dấu tiếng Việt để tránh lỗi WinAnsi của pdf-lib)
      if (!bannerDrawn) {
        try {
          const safeText = safeAscii(copyText);
          const timesRoman = await pdfDoc.embedFont(StandardFonts.TimesRoman);
          const fontSize = 9;
          const textWidth = timesRoman.widthOfTextAtSize(safeText, fontSize);
          const textX = p1W - textWidth - 40;
          const textY = p1H - 28;

          firstPage.drawText(safeText, {
            x: textX,
            y: textY,
            size: fontSize,
            font: timesRoman,
            color: rgb(0, 0, 0)
          });
          console.log(`[Copy Sign] 📋 Đã in dòng chữ ký Sao y (ASCII safe) tại Trang 1 (${textX.toFixed(1)}, ${textY.toFixed(1)}): "${safeText}"`);
        } catch (fontErr) {
          console.error('[Copy Sign] Lỗi in text sao y:', fontErr.message);
        }
      }

      // TUYỆT ĐỐI KHÔNG ĐÓNG DẤU CHỮ KÝ TAY CỦA GIÁO VIÊN VÀO VĂN BẢN KÝ SAO Y
      return await pdfDoc.save();
    }

    const lastDocPage = sourcePages[sourcePages.length - 1];
    const targetPageNum = (doc.signCoordinates && doc.signCoordinates.page > 0 && doc.signCoordinates.page <= sourcePages.length)
      ? doc.signCoordinates.page
      : ((doc.page > 0 && doc.page <= sourcePages.length) ? doc.page : sourcePages.length);
    const targetDocPage = sourcePages[targetPageNum - 1];
    const { width: pW, height: pH } = targetDocPage.getSize();
    
    // 1. Tìm chữ ký giáo viên (Cấp 1)
    const teacherSignature = (doc.signatures || []).find(s => s.step === 1);
    let teacherSigImgData = (teacherSignature && teacherSignature.visualSignImage) || doc.signatureImage;

    // Tìm buffer ảnh chữ ký giáo viên
    let teacherImgBuf = resolveImageBuffer(teacherSigImgData);
    if (!teacherImgBuf || teacherImgBuf.length < 300) {
      // Fallback chữ ký trong suốt mặc định của thầy Hà Văn Tý (87 KB sắc nét)
      const fallbackSig = path.join(__dirname, 'uploads', 'signatures', 'sig_user_cvaty.png');
      if (fs.existsSync(fallbackSig)) {
        teacherImgBuf = fs.readFileSync(fallbackSig);
      }
    }

    if (teacherImgBuf) {
      try {
        const pngSignImg = await embedImageToPdf(pdfDoc, teacherImgBuf);
        if (pngSignImg) {
          const scale = (doc.signCoordinates && typeof doc.signCoordinates.scale === 'number') 
            ? Math.max(0.4, Math.min(2.5, doc.signCoordinates.scale)) 
            : 1.0;
          const stampWidth = Math.round(((doc.signCoordinates && doc.signCoordinates.width) || 95) * scale);
          const stampHeight = Math.round(((doc.signCoordinates && doc.signCoordinates.height) || 60) * scale);

          const isLandscape = pW > pH;
          let defaultX = isLandscape ? (pW * 0.745) : (pW * 0.74);
          let defaultY = isLandscape ? 275 : 120;

          let stampX = defaultX;
          let stampY = defaultY;

          // Xác định vai trò mục tiêu theo vị trí kéo thả hoặc vai trò người ký
          let targetRole = 'teacher';
          if (doc.signCoordinates && typeof doc.signCoordinates.xPercent === 'number') {
            if (doc.signCoordinates.xPercent < 35) targetRole = 'principal';
            else if (doc.signCoordinates.xPercent <= 60) targetRole = 'leader';
            else targetRole = 'teacher';
          }

          // Nếu người dùng kéo thả thủ công (isManualDrag == true),
          // TÔN TRỌNG TUYỆT ĐỐI tọa độ kéo thả (x, y) hoặc (xPercent, yPercent)
          if (doc.signCoordinates && doc.signCoordinates.isManualDrag) {
            if (typeof doc.signCoordinates.x === 'number' && typeof doc.signCoordinates.y === 'number') {
              stampX = doc.signCoordinates.x;
              stampY = doc.signCoordinates.y;
            } else if (typeof doc.signCoordinates.xPercent === 'number' && typeof doc.signCoordinates.yPercent === 'number') {
              stampX = (doc.signCoordinates.xPercent / 100) * pW;
              stampY = pH - ((doc.signCoordinates.yPercent / 100) * pH) - stampHeight;
            }
            console.log(`[pdfSignerService] 🎯 Chế độ kéo thả thủ công (isManualDrag): Trang ${targetPageNum}, X=${stampX}, Y=${stampY}`);
          } else {
            // Tự động tìm neo vị trí chữ ký thông minh (Smart Pedagogical Anchor) cho ký tự động
            const signerTargetName = (teacherSignature && teacherSignature.signerName) || doc.author || 'Hà Văn Tý';
            const smartAnchor = await findSmartSignatureAnchor(sourcePdfBuffer, signerTargetName, targetRole);

            if (smartAnchor && smartAnchor.found) {
              stampX = smartAnchor.x;
              stampY = smartAnchor.y;
            } else if (doc.signPlacement === 'bottom-left' || targetRole === 'principal') {
              stampX = pW * 0.18;
              stampY = defaultY;
            } else if (doc.signPlacement === 'middle-right' || targetRole === 'leader') {
              stampX = pW * 0.46;
              stampY = defaultY;
            }
          }

          // Tự động kiểm tra biên an toàn (tránh văng khỏi trang PDF)
          stampX = Math.max(10, Math.min(pW - stampWidth - 10, stampX));
          stampY = Math.max(10, Math.min(pH - stampHeight - 10, stampY));

          targetDocPage.drawImage(pngSignImg, {
            x: stampX,
            y: stampY,
            width: stampWidth,
            height: stampHeight
          });
        }
      } catch (e) {
        console.error('Lỗi đóng dấu ảnh chữ ký trực tiếp lên trang văn bản:', e.message);
      }
    }

    // 2. Chữ ký Tổ trưởng chuyên môn (Duyệt cấp 2) nếu có
    const leaderSig = (doc.signatures || []).find(s => s.step === 2);
    if (leaderSig) {
      let leaderImgBuf = resolveImageBuffer(leaderSig.visualSignImage);
      if (leaderImgBuf) {
        try {
          const pngLeaderImg = await embedImageToPdf(pdfDoc, leaderImgBuf);
          if (pngLeaderImg) {
            const scale = (doc.signCoordinates && doc.signCoordinates.scale) || 1.0;
            const sW = Math.round(95 * scale);
            const sH = Math.round(60 * scale);
            let leaderX = (pW * 0.46);
            let leaderY = (pW > pH ? 275 : 120);

            const leaderName = (leaderSig && leaderSig.signerName) || 'Tổ trưởng chuyên môn';
            const leaderAnchor = await findSmartSignatureAnchor(sourcePdfBuffer, leaderName, 'leader');
            if (leaderAnchor && leaderAnchor.found) {
              leaderX = leaderAnchor.x;
              leaderY = leaderAnchor.y;
            }

            lastDocPage.drawImage(pngLeaderImg, {
              x: Math.max(10, Math.min(pW - sW - 10, leaderX)),
              y: Math.max(10, Math.min(pH - sH - 10, leaderY)),
              width: sW,
              height: sH
            });
          }
        } catch (e) {
          console.error('Lỗi đóng dấu tổ trưởng:', e.message);
        }
      }
    }

    // 3. Chữ ký Ban Giám hiệu & Con dấu số nhà trường (Phê duyệt cấp 3) nếu có
    const principalSig = (doc.signatures || []).find(s => s.step === 3);
    if (principalSig || doc.status === 'APPROVED') {
      try {
        let sealPath = path.join(__dirname, 'uploads', 'signatures', 'school_seal.png');
        if (!fs.existsSync(sealPath)) {
          sealPath = path.join(__dirname, 'school_seal.png');
        }
        if (fs.existsSync(sealPath)) {
          const sealBuf = fs.readFileSync(sealPath);
          const pngSeal = await embedImageToPdf(pdfDoc, sealBuf);
          if (pngSeal) {
            const sealSize = 105; // Tăng từ 85pt lên 105pt (chuẩn đường kính ~37mm theo Nghị định 99/2016/NĐ-CP)
            let sealX = (pW * 0.18);
            let sealY = (pW > pH ? 260 : 105);

            if (doc.signCoordinates && doc.signCoordinates.isManualDrag && typeof doc.signCoordinates.x === 'number' && typeof doc.signCoordinates.y === 'number') {
              sealX = doc.signCoordinates.x;
              sealY = doc.signCoordinates.y;
              if (typeof doc.signCoordinates.width === 'number' && Math.abs(sealSize - doc.signCoordinates.width) > 2) {
                sealX += (doc.signCoordinates.width - sealSize) / 2;
              }
              if (typeof doc.signCoordinates.height === 'number' && Math.abs(sealSize - doc.signCoordinates.height) > 2) {
                sealY += (doc.signCoordinates.height - sealSize) / 2;
              }
              console.log(`[pdfSignerService] 🎯 Con dấu kéo thả thủ công: Trang ${targetPageNum}, X=${sealX}, Y=${sealY}`);
            } else {
              const principalAnchor = await findSmartSignatureAnchor(sourcePdfBuffer, 'Ban Giám hiệu', 'principal');
              if (principalAnchor && principalAnchor.found) {
                sealX = principalAnchor.x;
                sealY = principalAnchor.y;
              }
            }

            lastDocPage.drawImage(pngSeal, {
              x: Math.max(10, Math.min(pW - sealSize - 10, sealX)),
              y: Math.max(10, Math.min(pH - sealSize - 10, sealY)),
              width: sealSize,
              height: sealSize
            });
          }
        }
      } catch (e) {
        console.error('Lỗi đóng con dấu nhà trường:', e.message);
      }
    }
  }

  // KHÔNG thêm trang phụ lục thừa - xuất thẳng PDF chuẩn chỉ chứa các trang bài dạy thực tế
  return await pdfDoc.save();
}

/**
 * Tìm tệp thực thi hoặc runner dotnet cho RealPdfSigner (Hỗ trợ Windows, Linux, Render Cloud)
 */
function findSignerRunner() {
  const candidates = [
    path.join(__dirname, 'RealPdfSigner', 'publish_single', 'RealPdfSigner.exe'),
    path.join(__dirname, 'RealPdfSigner', 'bin', 'Release', 'net8.0', 'RealPdfSigner.exe'),
    path.join(__dirname, 'RealPdfSigner', 'publish', 'RealPdfSigner.exe'),
    path.join(__dirname, 'downloads', 'RealPdfSigner.exe'),
    path.join(__dirname, 'public', 'downloads', 'RealPdfSigner.exe'),
    path.join(__dirname, 'public', 'downloads', 'EduSign_Agent.exe'),
    path.join(__dirname, 'RealPdfSigner', 'bin', 'Release', 'net8.0-windows', 'RealPdfSigner.exe'),
    path.join(__dirname, 'RealPdfSigner', 'bin', 'Debug', 'net8.0', 'RealPdfSigner.exe'),
    path.join(__dirname, 'RealPdfSigner', 'bin', 'Release', 'net8.0', 'RealPdfSigner'),
    path.join(__dirname, 'RealPdfSigner', 'bin', 'Debug', 'net8.0', 'RealPdfSigner')
  ];
  for (const c of candidates) {
    if (fs.existsSync(c)) {
      return { command: c, argsPrefix: [] };
    }
  }

  // Thử kiểm tra lệnh dotnet (nếu hệ thống đã cài đặt .NET SDK)
  try {
    const { execSync } = require('child_process');
    execSync('dotnet --version', { stdio: 'ignore', timeout: 2000 });
    const csproj = path.join(__dirname, 'RealPdfSigner', 'RealPdfSigner.csproj');
    if (fs.existsSync(csproj)) {
      return { command: 'dotnet', argsPrefix: ['run', '--project', path.join(__dirname, 'RealPdfSigner'), '--'] };
    }
  } catch (e) { void e; }

  return null;
}

/**
 * Tự động tìm tọa độ neo thông minh (Smart Pedagogical Anchor) cho chữ ký số
 * Dò tìm chính xác vị trí tên giáo viên / chức danh trên trang cuối văn bản
 */
async function findSmartSignatureAnchor(pdfBufferOrPath, signerName = 'Hà Văn Tý', role = 'teacher') {
  const runner = findSignerRunner();
  if (!runner) return null;

  let tempPath = null;
  let shouldCleanup = false;

  try {
    if (typeof pdfBufferOrPath === 'string' && fs.existsSync(pdfBufferOrPath)) {
      tempPath = pdfBufferOrPath;
    } else if (Buffer.isBuffer(pdfBufferOrPath)) {
      const tempDir = path.join(__dirname, 'uploads', 'documents');
      if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });
      tempPath = path.join(tempDir, `anchor_scan_${Date.now()}_${Math.random().toString(36).substring(7)}.pdf`);
      fs.writeFileSync(tempPath, pdfBufferOrPath);
      shouldCleanup = true;
    } else {
      return null;
    }

    const { execFile } = require('child_process');
    const stdout = await new Promise((resolve) => {
      execFile(runner.command, [...runner.argsPrefix, '--find-anchor', tempPath, signerName, role], { timeout: 10000 }, (err, out) => {
        if (err) resolve('');
        else resolve(out || '');
      });
    });

    if (stdout && stdout.includes('[ANCHOR_RESULT_JSON]')) {
      const jsonStr = stdout.split('[ANCHOR_RESULT_JSON]')[1].trim().split('\n')[0].trim();
      const parsed = JSON.parse(jsonStr);
      if (parsed && parsed.found) {
        return parsed;
      }
    }
  } catch (e) {
    // An toàn: nếu có lỗi thì trả về null để dùng tọa độ mặc định
  } finally {
    if (shouldCleanup && tempPath && fs.existsSync(tempPath)) {
      try { fs.unlinkSync(tempPath); } catch (e) { void e; }
    }
  }

  return null;
}

/**
 * Thực hiện ký số mật mã thật X.509 PAdES qua RealPdfSigner (Ban Cơ yếu Chính phủ - VGCA)
 * Hỗ trợ chuyển đổi mượt mà giữa máy tính Windows cục bộ và máy chủ đám mây Linux Render / Docker
 */
async function signWithRealVgca(doc) {
  if (!doc || typeof doc !== 'object') throw new TypeError('[signWithRealVgca] Dữ liệu tài liệu không hợp lệ.');
  // 1. Tạo file PDF đã đóng dấu ảnh chữ ký chuẩn
  const stampedPdfBuffer = await generateSignedPdf(doc);
  const tempDir = path.join(__dirname, 'uploads', 'documents');
  if (!fs.existsSync(tempDir)) fs.mkdirSync(tempDir, { recursive: true });

  const safeId = String(doc.id || 'doc').replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 50);
  const randSuffix = require('crypto').randomBytes(8).toString('hex');
  const tempInput = path.join(tempDir, `temp_stamped_${safeId}_${randSuffix}.pdf`);
  const tempOutput = path.join(tempDir, `RealSigned_${safeId}_${randSuffix}.pdf`);
  await fs.promises.writeFile(tempInput, stampedPdfBuffer);

  try {
    // 2. Tìm công cụ ký số RealPdfSigner
    const runner = findSignerRunner();
    if (runner) {
      const rawScale = Number(doc.signCoordinates && doc.signCoordinates.scale);
      const scale = (Number.isFinite(rawScale) && rawScale > 0) ? Math.min(rawScale, 10) : 1.0;
      const w = Math.round(90 * scale), h = Math.round(60 * scale);
      const rawSigner = (doc.signatures && doc.signatures[0] && doc.signatures[0].signerName) || doc.author || 'Hà Văn Tý';
      const cleanSigner = String(rawSigner).replace(/[\x00-\x1f\x7f]/g, '').trim().slice(0, 100);
      const signerName = cleanSigner.length > 0 ? cleanSigner : 'Hà Văn Tý';
      const defaultSig = path.join(__dirname, 'uploads', 'signatures', 'sig_user_cvaty.png');
      const sigImgPath = fs.existsSync(defaultSig) ? defaultSig : '';

      try {
        const isTestEnv = !!(process.env.NODE_ENV === 'test' || process.env.TEST_PORT);
        const signTimeout = isTestEnv ? 4000 : 35000;

        const result = await new Promise((resolve, reject) => {
          const { execFile } = require('child_process');
          const isCopy = (doc.signType === 'COPY' || doc.isCopySign === true);
          const cliArgs = isCopy ? [
            ...runner.argsPrefix,
            '--copy-sign',
            tempInput,
            tempOutput,
            doc.copyType || 'SAO Y',
            signerName
          ] : [
            ...runner.argsPrefix,
            '--sign',
            tempInput,
            tempOutput,
            '0',
            '-1',
            '-1',
            String(w),
            String(h),
            `${signerName} đã ký số VGCA`,
            'Quảng Ngãi',
            sigImgPath
          ];
          execFile(runner.command, cliArgs, { timeout: signTimeout }, (error, stdout, stderr) => {
            if (error) {
              console.warn('[VGCA Signer] C# Runner gặp lỗi hoặc môi trường không có CSP:', stderr || error.message);
              return reject(error);
            }

            if (fs.existsSync(tempOutput) && fs.statSync(tempOutput).size > 100) {
              const signedBuf = fs.readFileSync(tempOutput);
              resolve({
                signedBuffer: signedBuf,
                signedFilePath: tempOutput,
                isRealSigned: true,
                stdout
              });
            } else {
              reject(new Error('Chưa tạo được tệp kết quả sau khi ký số'));
            }
          });
        });
        return result;
      } catch (err) {
        console.error('[VGCA Engine] C# Runner thất bại:', err.message);
        try { if (fs.existsSync(tempOutput)) fs.unlinkSync(tempOutput); } catch (rmOutErr) { console.warn('[VGCA Signer] Lỗi dọn output tạm:', rmOutErr.message); }
        throw new Error(
          `Ký số thất bại: ${err.message}\n` +
          `Vui lòng kiểm tra:\n` +
          `1. EduSign Agent đang chạy (biểu tượng khiên xanh ở khay hệ thống)\n` +
          `2. Thiết bị USB Token đã cắm vào máy tính\n` +
          `3. Virtual CSP (vgca_vcsp_v2_mgr.exe) đang hoạt động`
        );
      }
    }

    throw new Error(
      'EduSign Agent chưa được cài đặt hoặc chưa chạy trên máy tính này.\n' +
      'Chữ ký số pháp lý VGCA yêu cầu EduSign Agent phải hoạt động cục bộ.\n' +
      'Vui lòng:\n' +
      '1. Tải và cài đặt EduSign Agent từ trang web\n' +
      '2. Chạy EduSign_Agent.exe → biểu tượng khiên xanh xuất hiện ở khay hệ thống\n' +
      '3. Thực hiện ký số lại'
    );
  } finally {
    try { if (fs.existsSync(tempInput)) fs.unlinkSync(tempInput); } catch (cleanErr) { console.warn('[VGCA Signer] Lỗi dọn tệp input tạm:', cleanErr.message); }
  }
}

module.exports = {
  generateSignedPdf,
  signWithRealVgca,
  convertDocxToPdf,
  findSmartSignatureAnchor
};

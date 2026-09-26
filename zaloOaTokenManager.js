/**
 * Module Quản lý Xác thực OAuth 2.0 Zalo Official Account v3
 * Tích hợp Mutex Lock ngăn ngừa hiện tượng Token Replay Race Condition
 * Hệ thống Ký số EduSign VGCA - THCS Chu Văn An
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

class ZaloOaTokenManager {
  constructor(config = {}) {
    this.appId = config.appId || process.env.ZALO_APP_ID || '';
    this.secretKey = config.secretKey || process.env.ZALO_SECRET_KEY || '';
    this.tokenFilePath = path.join(__dirname, 'data', 'zalo_oa_tokens.json');
    this.isRefreshing = false;
    this.refreshQueue = [];
  }

  loadTokens() {
    try {
      if (!fs.existsSync(this.tokenFilePath)) {
        return { access_token: '', refresh_token: '', expires_at: 0 };
      }
      const raw = fs.readFileSync(this.tokenFilePath, 'utf8');
      if (!raw || !raw.trim()) {
        return { access_token: '', refresh_token: '', expires_at: 0 };
      }
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        console.warn('[ZaloOaTokenManager] Dữ liệu token trong file không hợp lệ, khởi tạo cấu trúc mặc định.');
        return { access_token: '', refresh_token: '', expires_at: 0 };
      }
      return {
        access_token: typeof parsed.access_token === 'string' ? parsed.access_token : '',
        refresh_token: typeof parsed.refresh_token === 'string' ? parsed.refresh_token : '',
        expires_at: typeof parsed.expires_at === 'number' && Number.isFinite(parsed.expires_at) ? parsed.expires_at : 0
      };
    } catch (err) {
      if (err.code === 'ENOENT') {
        return { access_token: '', refresh_token: '', expires_at: 0 };
      }
      console.error('[ZaloOaTokenManager] Lỗi đọc tệp token:', err.message);
      throw new Error(`Không thể đọc tệp token Zalo OA: ${err.message}`);
    }
  }

  saveTokens(data, previousRefreshToken = '') {
    if (!data || typeof data !== 'object' || Array.isArray(data)) {
      throw new Error('Dữ liệu token từ Zalo OAuth không hợp lệ.');
    }
    const accessToken = typeof data.access_token === 'string' ? data.access_token.trim() : '';
    if (!accessToken) {
      throw new Error('Zalo OAuth response thiếu access_token hợp lệ.');
    }
    const refreshToken = typeof data.refresh_token === 'string' && data.refresh_token.trim()
      ? data.refresh_token.trim()
      : (typeof previousRefreshToken === 'string' ? previousRefreshToken.trim() : '');

    const parsedExpires = parseInt(data.expires_in, 10);
    const expiresIn = Number.isFinite(parsedExpires) && parsedExpires > 0 ? parsedExpires : 3600;
    const tokens = {
      access_token: accessToken,
      refresh_token: refreshToken,
      expires_at: Date.now() + Math.max(0, expiresIn - 300) * 1000 // Gia hạn trước 5 phút
    };

    const dir = path.dirname(this.tokenFilePath);
    fs.mkdirSync(dir, { recursive: true });

    // Ghi file nguyên tử (Atomic write qua temp file rồi rename)
    const tempFile = path.join(dir, `zalo_oa_tokens.${Date.now()}.${crypto.randomBytes(4).toString('hex')}.tmp`);
    try {
      fs.writeFileSync(tempFile, JSON.stringify(tokens, null, 2), 'utf8');
      fs.renameSync(tempFile, this.tokenFilePath);
    } catch (ioErr) {
      try {
        if (fs.existsSync(tempFile)) {
          fs.unlinkSync(tempFile);
        }
      } catch (cleanErr) {
        console.warn('[ZaloOaTokenManager] Không thể dọn tệp tạm:', cleanErr.message);
      }
      console.error('[ZaloOaTokenManager] Lỗi ghi tệp token nguyên tử:', ioErr.message);
      throw ioErr;
    }
    return tokens;
  }

  async getValidAccessToken() {
    let current;
    try {
      current = this.loadTokens();
    } catch (err) {
      console.warn('[ZaloOaTokenManager] Khởi tạo lại token rỗng sau lỗi load:', err.message);
      current = { access_token: '', refresh_token: '', expires_at: 0 };
    }

    if (!current || typeof current !== 'object' || Array.isArray(current)) {
      current = { access_token: '', refresh_token: '', expires_at: 0 };
    }

    const currentAccessToken = typeof current.access_token === 'string' ? current.access_token : '';
    const currentRefreshToken = typeof current.refresh_token === 'string' ? current.refresh_token.trim() : '';
    const currentExpiresAt = typeof current.expires_at === 'number' && Number.isFinite(current.expires_at) ? current.expires_at : 0;

    // Nếu token còn hiệu lực thì tái sử dụng
    if (currentAccessToken.length > 0 && Date.now() < currentExpiresAt) {
      return currentAccessToken;
    }

    // Nếu đang có tiến trình làm mới token, đưa vào hàng đợi Mutex kèm timeout phòng treo và dọn dẹp entry
    if (this.isRefreshing) {
      let entry;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          const index = this.refreshQueue.indexOf(entry);
          if (index !== -1) {
            this.refreshQueue.splice(index, 1);
          }
          reject(new Error('[ZaloOaTokenManager] Quá thời gian chờ làm mới token trong hàng đợi Mutex.'));
        }, 20000);

        entry = {
          resolve: (val) => {
            clearTimeout(timer);
            resolve(val);
          },
          reject: (err) => {
            clearTimeout(timer);
            reject(err);
          }
        };

        this.refreshQueue.push(entry);
      });
    }

    this.isRefreshing = true;
    try {
      const refreshed = await this.executeRefreshToken(currentRefreshToken);
      const queue = this.refreshQueue.slice();
      this.refreshQueue = [];
      queue.forEach(item => item.resolve(refreshed.access_token));
      return refreshed.access_token;
    } catch (err) {
      const queue = this.refreshQueue.slice();
      this.refreshQueue = [];
      queue.forEach(item => item.reject(err));
      throw err;
    } finally {
      this.isRefreshing = false;
    }
  }

  async executeRefreshToken(refreshToken) {
    if (!refreshToken || typeof refreshToken !== 'string' || !refreshToken.trim()) {
      throw new Error('Không tìm thấy Refresh Token Zalo OA hợp lệ.');
    }
    if (!this.appId || !this.secretKey) {
      throw new Error('Chưa cấu hình ZALO_APP_ID hoặc ZALO_SECRET_KEY trong môi trường.');
    }

    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), 15000); // 15s timeout

    let res;
    try {
      res = await fetch('https://oauth.zaloapp.com/v4/oa/access_token', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/x-www-form-urlencoded',
          'secret_key': this.secretKey
        },
        body: new URLSearchParams({
          refresh_token: refreshToken.trim(),
          app_id: this.appId,
          grant_type: 'refresh_token'
        }),
        signal: controller.signal
      });
    } catch (netErr) {
      clearTimeout(timeoutId);
      if (netErr.name === 'AbortError') {
        throw new Error('[Zalo OA OAuth Error] Quá thời gian kết nối (Timeout 15s) tới máy chủ Zalo.');
      }
      throw new Error(`[Zalo OA OAuth Network Error] ${netErr.message}`);
    }
    clearTimeout(timeoutId);

    let result;
    try {
      result = await res.json();
    } catch (jsonErr) {
      throw new Error(`[Zalo OA OAuth Error] Máy chủ Zalo trả về dữ liệu không phải JSON (HTTP ${res ? res.status : 'UNKNOWN'}): ${jsonErr.message}`);
    }

    if (!result || typeof result !== 'object' || Array.isArray(result) || result.error || !res.ok) {
      const errName = result && result.error_name ? result.error_name : (result && result.error ? String(result.error) : 'HTTP_ERROR');
      const errMsg = result && result.message ? result.message : `Lỗi làm mới token (HTTP ${res ? res.status : 'UNKNOWN'})`;
      throw new Error(`[Zalo OA OAuth Error] ${errName}: ${errMsg}`);
    }

    return this.saveTokens(result, refreshToken);
  }
}

module.exports = ZaloOaTokenManager;

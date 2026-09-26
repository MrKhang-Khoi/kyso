// Service Worker for Hệ thống Ký số THCS Chu Văn An
// Hỗ trợ Web Push Notification trên điện thoại di động & máy tính (PWA)

self.addEventListener('install', () => {
  self.skipWaiting();
});

self.addEventListener('activate', (event) => {
  event.waitUntil(self.clients.claim());
});

// Hàm chuẩn hóa và kiểm tra an toàn URL điều hướng (chống Open Redirect & giả mạo nguồn)
function sanitizeTargetUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || !rawUrl.trim()) {
    return '/';
  }
  try {
    const parsed = new URL(rawUrl, self.location.origin);
    if (parsed.origin === self.location.origin && (parsed.protocol === 'http:' || parsed.protocol === 'https:')) {
      return parsed.pathname + parsed.search + parsed.hash;
    }
    console.warn('[ServiceWorker] Từ chối URL điều hướng khác origin hoặc sai giao thức:', rawUrl);
  } catch (parseErr) {
    console.warn('[ServiceWorker] Lỗi phân tích cú pháp URL điều hướng:', parseErr.message);
  }
  return '/';
}

// Xử lý sự kiện Push Notification từ máy chủ
self.addEventListener('push', (event) => {
  let data = {
    title: 'Hệ thống Ký số THCS Chu Văn An',
    body: 'Bạn có thông báo mới từ hệ thống ký số.',
    url: '/'
  };

  if (event.data) {
    let rawText = '';
    try {
      rawText = event.data.text();
    } catch (readErr) {
      console.warn('[ServiceWorker] Không thể đọc nội dung push payload:', readErr.message);
    }

    if (rawText) {
      try {
        const payload = JSON.parse(rawText);
        if (payload && typeof payload === 'object' && !Array.isArray(payload)) {
          if (typeof payload.title === 'string' && payload.title.trim()) {
            data.title = payload.title.trim().slice(0, 150);
          }
          if (typeof payload.body === 'string' && payload.body.trim()) {
            data.body = payload.body.trim().slice(0, 500);
          }
          data.url = sanitizeTargetUrl(payload.url);
        }
      } catch (_) {
        // Nếu không phải JSON, sử dụng chính chuỗi rawText với giới hạn độ dài an toàn
        data.body = rawText.trim().slice(0, 500);
      }
    }
  }

  const options = {
    body: data.body,
    icon: '/favicon.ico',
    badge: '/favicon.ico',
    vibrate: [100, 50, 100],
    data: {
      url: data.url
    },
    actions: [
      { action: 'open', title: 'Xem chi tiết' },
      { action: 'close', title: 'Đóng' }
    ]
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});

// Nhấp vào thông báo sẽ mở / chuyển đến trang tài liệu an toàn cùng origin
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  if (event.action === 'close') return;

  const rawUrl = (event.notification.data && event.notification.data.url) ? event.notification.data.url : '/';
  const targetPath = sanitizeTargetUrl(rawUrl);
  const targetUrl = new URL(targetPath, self.location.origin).href;

  event.waitUntil(
    clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((windowClients) => {
        for (let client of windowClients) {
          if ('focus' in client) {
            try {
              const clientUrl = new URL(client.url);
              if (clientUrl.origin === self.location.origin) {
                return client.navigate(targetUrl).then(() => client.focus());
              }
            } catch (urlErr) {
              console.warn('[ServiceWorker] Lỗi phân tích client URL:', urlErr.message);
            }
          }
        }
        if (clients.openWindow) {
          return clients.openWindow(targetUrl);
        }
      })
      .catch((navErr) => {
        console.warn('[ServiceWorker] Xử lý điều hướng khi nhấp thông báo thất bại:', navErr.message);
      })
  );
});

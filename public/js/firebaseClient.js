/**
 * EduSign Firebase Client Adapter (Hybrid Mode)
 * Hỗ trợ đồng bộ dữ liệu thời gian thực (Realtime Sync) qua Google Cloud Firebase
 * Hỗ trợ cả Firebase Realtime Database (WebSocket Singapore) và Cloud Firestore
 */

(function() {
  let rtdb = null;
  let firestore = null;
  let isInitialized = false;

  function initFirebase() {
    if (isInitialized) return { rtdb, firestore };

    const config = typeof window !== 'undefined' ? window.FIREBASE_CONFIG : null;
    const isValidApiKey = Boolean(config && typeof config.apiKey === 'string' && !config.apiKey.includes('YOUR_API_KEY'));
    if (config && config.enabled && isValidApiKey && typeof firebase !== 'undefined') {
      try {
        if (!firebase.apps.length) {
          firebase.initializeApp(config);
        }

        // 1. Khởi tạo Firebase Realtime Database (Singapore)
        if (typeof firebase.database === 'function') {
          try {
            rtdb = firebase.database();
            console.log('⚡ [Firebase] Kết nối Realtime Database Singapore thành công!');
          } catch (eDb) {
            console.warn('Realtime DB init note:', eDb.message);
          }
        }

        // 2. Khởi tạo Cloud Firestore
        if (typeof firebase.firestore === 'function') {
          try {
            firestore = firebase.firestore();
          } catch (eFs) {
            console.warn('Firestore init note:', eFs.message);
          }
        }

        if (rtdb || firestore) {
          isInitialized = true;
          updateFirebaseStatusUI('ACTIVE');
          return { rtdb, firestore };
        }
      } catch (err) {
        console.warn('⚠️ [Firebase] Lỗi khởi tạo:', err.message);
      }
    }
    
    updateFirebaseStatusUI('LOCAL');
    return null;
  }

  function updateFirebaseStatusUI(status) {
    const badge = document.getElementById('firebaseStatusBadge');
    const modalBox = document.getElementById('firebaseConnectionState');
    const modalDesc = document.getElementById('firebaseStatusDesc');

    if (badge) {
      badge.classList.remove('hidden');
      if (status === 'ACTIVE') {
        badge.innerHTML = '<i class="fa-solid fa-bolt text-amber-300 animate-pulse"></i> Cloud Realtime: Đang bật'; // sanitize: safe static
        badge.className = 'flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl bg-emerald-600 text-white border border-emerald-500 cursor-pointer transition shadow-sm';
        badge.title = 'Đang đồng bộ dữ liệu thời gian thực qua Google Firebase (Singapore). Không cần bấm F5 khi duyệt bài.';
        if (modalBox) {
          modalBox.innerText = 'Cloud Realtime: Đang hoạt động (Singapore)';
          modalBox.className = 'px-2.5 py-0.5 rounded-full bg-emerald-100 text-emerald-800 font-bold';
        }
        if (modalDesc) {
          modalDesc.innerHTML = '🎉 Dự án <strong>edusign-school</strong> đã kết nối THÀNH CÔNG với Google Cloud Firebase (Singapore)! Khi BGH ký số duyệt bài, giao diện của Giáo viên và Tổ trưởng sẽ tự động nhảy trạng thái ngay lập tức mà không cần bấm F5.'; // sanitize: safe static
        }
      } else {
        badge.innerHTML = '<i class="fa-solid fa-server text-slate-400"></i> Local Server Mode'; // sanitize: safe static
        badge.className = 'flex items-center gap-1.5 px-3 py-1.5 text-xs font-semibold rounded-xl bg-slate-100 text-slate-700 border border-slate-200 hover:bg-slate-200 cursor-pointer transition shadow-sm';
        badge.title = 'Hệ thống đang chạy qua máy chủ REST API.';
        if (modalBox) {
          modalBox.innerText = 'Local Server Mode';
          modalBox.className = 'px-2.5 py-0.5 rounded-full bg-slate-200 text-slate-700 font-semibold';
        }
      }
    }
  }

  // Lắng nghe hồ sơ thay đổi thời gian thực
  function subscribeDocuments(onDataChanged) {
    const engines = initFirebase();
    if (!engines) return null;

    // Ưu tiên 1: Firebase Realtime Database (WebSocket cực nhanh tại Singapore)
    if (engines.rtdb) {
      try {
        const docRef = engines.rtdb.ref('documents');
        const onValue = (snapshot) => {
          updateFirebaseStatusUI('ACTIVE');
          const val = snapshot ? snapshot.val() : null;
          let docs = [];
          if (val) {
            if (Array.isArray(val)) {
              docs = val.filter(Boolean);
            } else if (typeof val === 'object') {
              docs = Object.values(val);
            }
          }
          if (typeof onDataChanged === 'function') {
            console.log(`⚡ [Firebase Realtime] Nhận cập nhật: ${docs.length} hồ sơ`);
            try {
              onDataChanged(docs);
            } catch (cbErr) {
              console.error(
                'Lỗi xử lý dữ liệu Firebase:',
                cbErr instanceof Error ? cbErr.message : String(cbErr ?? 'Unknown callback error')
              );
            }
          }
        };
        const onError = (err) => {
          const message = err instanceof Error
            ? err.message
            : String(err ?? 'Unknown Firebase listener error');
          console.warn('Realtime DB listener note:', message);
        };

        const unsubscribe = docRef.on('value', onValue, onError);
        return typeof unsubscribe === 'function'
          ? unsubscribe
          : () => docRef.off('value', onValue);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e ?? 'Unknown error');
        console.warn('Lỗi kết nối Realtime Database:', message);
      }
    }

    // Ưu tiên 2: Cloud Firestore
    if (engines.firestore) {
      try {
        const unsubscribe = engines.firestore.collection('documents')
          .orderBy('createdAt', 'desc')
          .onSnapshot((snapshot) => {
            updateFirebaseStatusUI('ACTIVE');
            const docs = [];
            if (snapshot) {
              snapshot.forEach(docSnap => {
                docs.push({ id: docSnap.id, ...docSnap.data() });
              });
            }
            if (typeof onDataChanged === 'function') {
              try {
                onDataChanged(docs);
              } catch (cbErr) {
                console.error(
                  'Lỗi xử lý dữ liệu Firebase Firestore:',
                  cbErr instanceof Error ? cbErr.message : String(cbErr ?? 'Unknown callback error')
                );
              }
            }
          }, (error) => {
            const message = error instanceof Error
              ? error.message
              : String(error ?? 'Unknown Firestore listener error');
            console.warn('⚠️ [Firestore Realtime] Lỗi lắng nghe:', message);
          });
        return typeof unsubscribe === 'function' ? unsubscribe : () => {};
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err ?? 'Unknown error');
        console.warn('Lỗi kết nối Firestore:', message);
      }
    }

    return null;
  }

  // Đồng bộ danh sách hồ sơ lên Firebase
  function syncDocumentsToFirebase(docs) {
    const engines = initFirebase();
    if (!engines || !docs || !Array.isArray(docs)) return;

    if (engines.rtdb) {
      try {
        const cleanDocs = docs.map(d => {
          const c = { ...d };
          delete c.fileBase64;
          delete c.signedPdfBase64;
          return c;
        });
        engines.rtdb.ref('documents').set(cleanDocs)
          .then(() => console.log('☁️ [Firebase] Đã đồng bộ danh sách hồ sơ lên Cloud!'))
          .catch(e => {
            const message = e instanceof Error ? e.message : String(e ?? 'Unknown error');
            console.warn('Lỗi sync docs:', message);
          });
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e ?? 'Unknown error');
        console.warn('Lỗi sync docs:', message);
      }
    }
  }

  // Cung cấp API ra ngoài
  window.EduSignFirebase = {
    init: initFirebase,
    isAvailable: function() {
      return !!initFirebase();
    },
    subscribeDocuments: subscribeDocuments,
    syncDocumentsToFirebase: syncDocumentsToFirebase,
    updateStatusUI: updateFirebaseStatusUI
  };

  // Tự động kiểm tra khi tải trang xong
  window.addEventListener('DOMContentLoaded', () => {
    initFirebase();
  });
})();

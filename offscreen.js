// offscreen.js - 使用真实 DOM Blob + anchor 下载，确保文件名正确
chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
  if (message.type === 'TRIGGER_DOWNLOAD') {
    triggerDownload(message.filename, message.content, message.mimeType)
      .then(function() { sendResponse({ success: true }); })
      .catch(function(error) { sendResponse({ success: false, error: error.message }); });
    return true;
  }
});

function triggerDownload(filename, content, mimeType) {
  return new Promise(function(resolve, reject) {
    try {
      var blob = new Blob([content], { type: mimeType || 'text/markdown;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      setTimeout(function() {
        URL.revokeObjectURL(url);
        resolve();
      }, 1000);
    } catch (error) {
      reject(error);
    }
  });
}

console.log('[AI Export] Offscreen document loaded');

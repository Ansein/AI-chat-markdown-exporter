// popup.js - Popup interface logic
document.addEventListener('DOMContentLoaded', async () => {
  const statusEl = document.getElementById('status');
  const exportBtn = document.getElementById('exportBtn');
  const messageCountEl = document.getElementById('messageCount');
  const refreshBtn = document.getElementById('refreshBtn');
  const progressEl = document.querySelector('.progress');
  const progressFill = document.getElementById('progressFill');
  const logEl = document.getElementById('log');

  let currentPlatform = null;
  let capturedMessages = [];

  function log(message) {
    const item = document.createElement('div');
    item.className = 'log-item';
    item.textContent = '[' + new Date().toLocaleTimeString() + '] ' + message;
    logEl.appendChild(item);
    logEl.scrollTop = logEl.scrollHeight;
  }

  async function getCurrentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  async function ensureContentScriptReady(tabId) {
    try {
      return await chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_INFO' });
    } catch (error) {
      var msg = error.message || '';
      if (msg.indexOf('Receiving end does not exist') === -1) {
        throw error;
      }
      log('Page script not connected, injecting...');
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js']
      });
      await new Promise(function(r) { setTimeout(r, 300); });
      return await chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_INFO' });
    }
  }

  async function sendTabMessageWithRetry(tabId, payload) {
    try {
      return await chrome.tabs.sendMessage(tabId, payload);
    } catch (error) {
      var msg = error.message || '';
      if (msg.indexOf('Receiving end does not exist') === -1) {
        throw error;
      }
      log('Tab lost, re-injecting...');
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js']
      });
      await new Promise(function(r) { setTimeout(r, 300); });
      return await chrome.tabs.sendMessage(tabId, payload);
    }
  }

  // Detect platform
  async function detectPlatform() {
    try {
      const tab = await getCurrentTab();
      const url = tab.url;
      log('Detecting platform: ' + url);

      if (url.indexOf('chatgpt.com') !== -1 || url.indexOf('chat.openai.com') !== -1) {
        currentPlatform = 'chatgpt';
        statusEl.className = 'status detected';
        statusEl.textContent = 'Detected: ChatGPT';
        exportBtn.disabled = false;
        log('ChatGPT recognized');
      } else if (url.indexOf('claude.ai') !== -1 || url.indexOf('anthropic.com') !== -1) {
        currentPlatform = 'claude';
        statusEl.className = 'status detected';
        statusEl.textContent = 'Detected: Claude';
        exportBtn.disabled = false;
        log('Claude recognized');
      } else {
        currentPlatform = 'unknown';
        statusEl.className = 'status unknown';
        statusEl.textContent = 'Unknown platform - will try generic extraction';
        exportBtn.disabled = false;
        log('Unknown platform, using generic extraction');
      }

      try {
        const response = await ensureContentScriptReady(tab.id);
        log('Page info: ' + JSON.stringify(response));
      } catch (err) {
        log('Cannot get page info: ' + err.message);
      }
    } catch (error) {
      statusEl.className = 'status error';
      statusEl.textContent = 'Detection failed: ' + error.message;
      log('Detection error: ' + error.message);
    }
  }

  // Download file using Blob + anchor (popup has DOM access)
  function downloadFile(filename, content) {
    var blob = new Blob([content], { type: 'text/markdown;charset=utf-8' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.style.display = 'none';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
  }

  // Export conversation
  async function exportConversation() {
    try {
      const tab = await getCurrentTab();
      exportBtn.disabled = true;
      progressEl.style.display = 'block';
      progressFill.style.width = '20%';
      log('Starting export...');

      // Get conversation data from content script
      const result = await sendTabMessageWithRetry(tab.id, {
        type: 'EXPORT_CURRENT_CONVERSATION',
        platform: currentPlatform
      });

      progressFill.style.width = '40%';
      var msgCount = result.messages ? result.messages.length : 0;
      log('Data extracted: ' + msgCount + ' messages');

      if (result.error) {
        throw new Error(result.error);
      }

      // Get settings
      const settings = {
        includeTimestamp: document.getElementById('optTimestamp').checked,
        includeModelInfo: document.getElementById('optModel').checked,
        includeReferences: document.getElementById('optReferences').checked,
        includeReasoningSummary: document.getElementById('optReasoning').checked,
        format: 'markdown',
        filenameTemplate: '{title}_{timestamp}.md'
      };

      progressFill.style.width = '60%';
      log('Converting to Markdown...');

      // Send to background for conversion
      const convertResult = await new Promise(function(resolve) {
        chrome.runtime.sendMessage({
          type: 'CONVERT_TO_MARKDOWN',
          data: {
            conversation: result,
            settings: settings
          }
        }, resolve);
      });

      progressFill.style.width = '80%';

      if (!convertResult || !convertResult.success) {
        throw new Error(convertResult && convertResult.error ? convertResult.error : 'Conversion failed');
      }

      // Download in popup using Blob + anchor (reliable filename)
      downloadFile(convertResult.filename, convertResult.markdown);

      progressFill.style.width = '100%';
      statusEl.className = 'status detected';
      statusEl.textContent = 'Export successful!';
      log('Export successful: ' + convertResult.filename);
      messageCountEl.textContent = 'Exported ' + msgCount + ' messages';

    } catch (error) {
      statusEl.className = 'status error';
      statusEl.textContent = 'Export failed: ' + error.message;
      log('Export error: ' + error.message);
    } finally {
      exportBtn.disabled = false;
      setTimeout(function() {
        progressEl.style.display = 'none';
        progressFill.style.width = '0%';
      }, 1000);
    }
  }

  // Load saved settings
  async function loadSettings() {
    try {
      const result = await new Promise(function(resolve) {
        chrome.runtime.sendMessage({ type: 'GET_EXPORT_SETTINGS' }, resolve);
      });
      if (result) {
        document.getElementById('optTimestamp').checked = result.includeTimestamp !== false;
        document.getElementById('optModel').checked = result.includeModelInfo !== false;
        document.getElementById('optReferences').checked = result.includeReferences !== false;
        document.getElementById('optReasoning').checked = result.includeReasoningSummary !== false;
      }
    } catch (err) {
      log('Failed to load settings: ' + err.message);
    }
  }

  // Save settings
  function saveSettings() {
    const settings = {
      includeTimestamp: document.getElementById('optTimestamp').checked,
      includeModelInfo: document.getElementById('optModel').checked,
      includeReferences: document.getElementById('optReferences').checked,
      includeReasoningSummary: document.getElementById('optReasoning').checked
    };
    chrome.runtime.sendMessage({
      type: 'SAVE_EXPORT_SETTINGS',
      settings: settings
    });
  }

  // Event listeners
  exportBtn.addEventListener('click', exportConversation);
  refreshBtn.addEventListener('click', async () => {
    log('Refreshing detection...');
    await detectPlatform();
  });

  ['optTimestamp', 'optModel', 'optReferences', 'optReasoning'].forEach(function(id) {
    document.getElementById(id).addEventListener('change', saveSettings);
  });

  // Listen for data captured from page
  chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
    if (message.type === 'PAGE_DATA_CAPTURED') {
      const data = message.data;
      if (data.messages) {
        capturedMessages = data.messages;
        messageCountEl.textContent = 'Captured ' + capturedMessages.length + ' messages';
        log('New messages captured');
      }
    }
  });

  // Initialize
  log('Popup loaded');
  await loadSettings();
  await detectPlatform();
});

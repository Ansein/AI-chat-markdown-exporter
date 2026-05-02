// popup.js - Popup interface logic (v2.0)
document.addEventListener('DOMContentLoaded', async () => {
  const statusEl = document.getElementById('status');
  const exportBtn = document.getElementById('exportBtn');
  const saveToCacheBtn = document.getElementById('saveToCacheBtn');
  const messageCountEl = document.getElementById('messageCount');
  const refreshBtn = document.getElementById('refreshBtn');
  const progressEl = document.querySelector('.progress');
  const progressFill = document.getElementById('progressFill');
  const logEl = document.getElementById('log');

  const tabs = document.querySelectorAll('.tab');
  const tabContents = document.querySelectorAll('.tab-content');

  const searchInput = document.getElementById('searchInput');
  const platformFilter = document.getElementById('platformFilter');
  const conversationList = document.getElementById('conversationList');
  const selectAllCheckbox = document.getElementById('selectAllCheckbox');
  const selectedCountEl = document.getElementById('selectedCount');
  const batchExportBtn = document.getElementById('batchExportBtn');
  const batchDeleteBtn = document.getElementById('batchDeleteBtn');
  const exportAllBtn = document.getElementById('exportAllBtn');
  const clearCacheBtn = document.getElementById('clearCacheBtn');
  const importFileInput = document.getElementById('importFileInput');

  let currentPlatform = null;
  let capturedMessages = [];
  let currentConversationData = null;
  let cacheConversations = [];
  let selectedConversationIds = new Set();
  let currentFilter = { query: '', platform: null };

  const platformDisplayNames = {
    chatgpt: 'ChatGPT',
    claude: 'Claude',
    yiyan: '文心一言',
    xinghuo: '讯飞星火',
    tongyi: '通义千问',
    doubao: '豆包',
  };

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
      await new Promise(function(r) { setTimeout(r, 500); });
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
      await new Promise(function(r) { setTimeout(r, 500); });
      return await chrome.tabs.sendMessage(tabId, payload);
    }
  }

  tabs.forEach(tab => {
    tab.addEventListener('click', () => {
      const tabName = tab.dataset.tab;

      tabs.forEach(t => t.classList.remove('active'));
      tabContents.forEach(c => c.classList.remove('active'));

      tab.classList.add('active');
      document.getElementById(tabName + '-tab').classList.add('active');

      if (tabName === 'history') {
        loadCacheConversations();
      }
    });
  });

  async function detectPlatform() {
    try {
      const tab = await getCurrentTab();
      const url = tab.url;
      log('Detecting platform: ' + (url ? url.slice(0, 50) : 'unknown'));

      if (url.indexOf('chatgpt.com') !== -1 || url.indexOf('chat.openai.com') !== -1) {
        currentPlatform = 'chatgpt';
        statusEl.className = 'status detected';
        statusEl.textContent = 'Detected: ChatGPT';
        exportBtn.disabled = false;
        saveToCacheBtn.disabled = false;
        log('ChatGPT recognized');
      } else if (url.indexOf('claude.ai') !== -1 || url.indexOf('anthropic.com') !== -1) {
        currentPlatform = 'claude';
        statusEl.className = 'status detected';
        statusEl.textContent = 'Detected: Claude';
        exportBtn.disabled = false;
        saveToCacheBtn.disabled = false;
        log('Claude recognized');
      } else if (url.indexOf('yiyan.baidu.com') !== -1 || url.indexOf('yiyan.baidu.com.cn') !== -1) {
        currentPlatform = 'yiyan';
        statusEl.className = 'status detected';
        statusEl.textContent = 'Detected: 文心一言';
        exportBtn.disabled = false;
        saveToCacheBtn.disabled = false;
        log('文心一言 recognized');
      } else if (url.indexOf('xinghuo.xfyun.cn') !== -1 || url.indexOf('sparkdesk.xfyun.cn') !== -1) {
        currentPlatform = 'xinghuo';
        statusEl.className = 'status detected';
        statusEl.textContent = 'Detected: 讯飞星火';
        exportBtn.disabled = false;
        saveToCacheBtn.disabled = false;
        log('讯飞星火 recognized');
      } else if (url.indexOf('tongyi.aliyun.com') !== -1 || url.indexOf('qianwen.aliyun.com') !== -1) {
        currentPlatform = 'tongyi';
        statusEl.className = 'status detected';
        statusEl.textContent = 'Detected: 通义千问';
        exportBtn.disabled = false;
        saveToCacheBtn.disabled = false;
        log('通义千问 recognized');
      } else if (url.indexOf('doubao.com') !== -1) {
        currentPlatform = 'doubao';
        statusEl.className = 'status detected';
        statusEl.textContent = 'Detected: 豆包';
        exportBtn.disabled = false;
        saveToCacheBtn.disabled = false;
        log('豆包 recognized');
      } else {
        currentPlatform = 'unknown';
        statusEl.className = 'status unknown';
        statusEl.textContent = 'Unknown platform - will try generic extraction';
        exportBtn.disabled = false;
        saveToCacheBtn.disabled = false;
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

  async function exportConversation() {
    try {
      const tab = await getCurrentTab();
      exportBtn.disabled = true;
      saveToCacheBtn.disabled = true;
      progressEl.style.display = 'block';
      progressFill.style.width = '20%';
      log('Starting export...');

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

      currentConversationData = result;

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
      saveToCacheBtn.disabled = false;
      setTimeout(function() {
        progressEl.style.display = 'none';
        progressFill.style.width = '0%';
      }, 1000);
    }
  }

  async function saveCurrentToCache() {
    try {
      const tab = await getCurrentTab();
      exportBtn.disabled = true;
      saveToCacheBtn.disabled = true;
      progressEl.style.display = 'block';
      progressFill.style.width = '20%';
      log('Saving to cache...');

      let result = currentConversationData;
      if (!result) {
        result = await sendTabMessageWithRetry(tab.id, {
          type: 'EXPORT_CURRENT_CONVERSATION',
          platform: currentPlatform
        });
        progressFill.style.width = '40%';
      }

      if (result.error) {
        throw new Error(result.error);
      }

      if (!result.messages || result.messages.length === 0) {
        throw new Error('No messages found to save');
      }

      progressFill.style.width = '60%';

      const saveResult = await new Promise(resolve => {
        chrome.runtime.sendMessage({
          type: 'SAVE_TO_CACHE',
          conversation: result
        }, resolve);
      });

      progressFill.style.width = '100%';

      if (saveResult && saveResult.success) {
        currentConversationData = saveResult.conversation;
        statusEl.className = 'status detected';
        statusEl.textContent = 'Saved to cache!';
        log('Saved to cache successfully');
        messageCountEl.textContent = 'Saved ' + result.messages.length + ' messages';
      } else {
        throw new Error(saveResult?.error || 'Save failed');
      }

    } catch (error) {
      statusEl.className = 'status error';
      statusEl.textContent = 'Save failed: ' + error.message;
      log('Save error: ' + error.message);
    } finally {
      exportBtn.disabled = false;
      saveToCacheBtn.disabled = false;
      setTimeout(function() {
        progressEl.style.display = 'none';
        progressFill.style.width = '0%';
      }, 1000);
    }
  }

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

  async function loadCacheConversations() {
    try {
      log('Loading cache conversations...');

      const result = await new Promise(resolve => {
        chrome.runtime.sendMessage({
          type: 'GET_CACHE_LIST',
          options: currentFilter
        }, resolve);
      });

      if (result && result.success) {
        cacheConversations = result.conversations || [];
        renderConversationList();
        log('Loaded ' + cacheConversations.length + ' conversations from cache');
      } else {
        log('Failed to load cache: ' + (result?.error || 'unknown error'));
      }
    } catch (error) {
      log('Cache load error: ' + error.message);
    }
  }

  function renderConversationList() {
    if (cacheConversations.length === 0) {
      conversationList.innerHTML = `
        <div class="empty-state">
          <div class="empty-state-icon">📂</div>
          <div>暂无历史记录</div>
          <div style="font-size: 11px; margin-top: 4px;">保存的会话将显示在这里</div>
        </div>
      `;
      updateSelectedCount();
      return;
    }

    let html = '';
    cacheConversations.forEach((conv, index) => {
      const isSelected = selectedConversationIds.has(conv.id);
      const platformName = platformDisplayNames[conv.platform] || conv.platform || 'AI';
      const messageCount = conv.messages?.length || 0;
      const exportedAt = conv.exportedAt ? new Date(conv.exportedAt).toLocaleString() : '';
      const platformClass = `platform-${conv.platform || 'unknown'}`;

      html += `
        <div class="conversation-item ${isSelected ? 'selected' : ''}" data-id="${conv.id}">
          <input type="checkbox" class="conversation-checkbox" data-id="${conv.id}" ${isSelected ? 'checked' : ''}>
          <div class="conversation-info">
            <div class="conversation-title">
              ${conv.title || '未命名会话'}
              <span class="platform-badge ${platformClass}">${platformName}</span>
            </div>
            <div class="conversation-meta">
              <span>${messageCount} 条消息</span>
              ${exportedAt ? `<span>${exportedAt}</span>` : ''}
            </div>
          </div>
        </div>
      `;
    });

    conversationList.innerHTML = html;

    document.querySelectorAll('.conversation-checkbox').forEach(checkbox => {
      checkbox.addEventListener('change', (e) => {
        e.stopPropagation();
        const id = e.target.dataset.id;
        if (e.target.checked) {
          selectedConversationIds.add(id);
        } else {
          selectedConversationIds.delete(id);
        }
        updateSelectedCount();
        updateSelectAllCheckbox();

        const item = e.target.closest('.conversation-item');
        if (item) {
          item.classList.toggle('selected', e.target.checked);
        }
      });
    });

    document.querySelectorAll('.conversation-item').forEach(item => {
      item.addEventListener('click', (e) => {
        if (e.target.type === 'checkbox') return;

        const checkbox = item.querySelector('.conversation-checkbox');
        if (checkbox) {
          checkbox.checked = !checkbox.checked;
          checkbox.dispatchEvent(new Event('change', { bubbles: true }));
        }
      });
    });

    updateSelectedCount();
    updateSelectAllCheckbox();
  }

  function updateSelectedCount() {
    selectedCountEl.textContent = selectedConversationIds.size;

    const hasSelection = selectedConversationIds.size > 0;
    batchExportBtn.disabled = !hasSelection;
    batchDeleteBtn.disabled = !hasSelection;
  }

  function updateSelectAllCheckbox() {
    if (cacheConversations.length === 0) {
      selectAllCheckbox.checked = false;
      selectAllCheckbox.indeterminate = false;
      return;
    }

    const allSelected = cacheConversations.every(conv => selectedConversationIds.has(conv.id));
    const someSelected = cacheConversations.some(conv => selectedConversationIds.has(conv.id));

    selectAllCheckbox.checked = allSelected;
    selectAllCheckbox.indeterminate = someSelected && !allSelected;
  }

  async function batchExport() {
    try {
      const selectedConversations = cacheConversations.filter(c => selectedConversationIds.has(c.id));

      if (selectedConversations.length === 0) {
        log('No conversations selected');
        return;
      }

      log('Batch exporting ' + selectedConversations.length + ' conversations...');

      const settings = {
        includeTimestamp: document.getElementById('optTimestamp').checked,
        includeModelInfo: document.getElementById('optModel').checked,
        includeReferences: document.getElementById('optReferences').checked,
        includeReasoningSummary: document.getElementById('optReasoning').checked,
        format: 'markdown',
        filenameTemplate: '{title}_{timestamp}.md'
      };

      const result = await new Promise(resolve => {
        chrome.runtime.sendMessage({
          type: 'BATCH_EXPORT_CONVERSATIONS',
          conversations: selectedConversations,
          settings: settings
        }, resolve);
      });

      if (result && result.success) {
        log('Batch export successful: ' + result.filename);
        statusEl.className = 'status detected';
        statusEl.textContent = 'Batch export successful!';
      } else {
        throw new Error(result?.error || 'Batch export failed');
      }

    } catch (error) {
      log('Batch export error: ' + error.message);
      statusEl.className = 'status error';
      statusEl.textContent = 'Batch export failed: ' + error.message;
    }
  }

  async function batchDelete() {
    if (selectedConversationIds.size === 0) return;

    const confirmMsg = `确定要删除选中的 ${selectedConversationIds.size} 个会话吗？`;
    if (!confirm(confirmMsg)) return;

    try {
      for (const id of selectedConversationIds) {
        await new Promise(resolve => {
          chrome.runtime.sendMessage({
            type: 'DELETE_FROM_CACHE',
            id: id
          }, resolve);
        });
      }

      selectedConversationIds.clear();
      log('Deleted ' + selectedConversationIds.size + ' conversations');

      await loadCacheConversations();
      updateSelectedCount();

    } catch (error) {
      log('Delete error: ' + error.message);
    }
  }

  async function exportAllCache() {
    try {
      log('Exporting all cache as backup...');

      const result = await new Promise(resolve => {
        chrome.runtime.sendMessage({
          type: 'EXPORT_ALL_CACHE'
        }, resolve);
      });

      if (result && result.success) {
        log('Backup export successful: ' + result.filename);
        statusEl.className = 'status detected';
        statusEl.textContent = 'Backup export successful!';
      } else {
        throw new Error(result?.error || 'Export failed');
      }

    } catch (error) {
      log('Export error: ' + error.message);
      statusEl.className = 'status error';
      statusEl.textContent = 'Export failed: ' + error.message;
    }
  }

  async function clearAllCache() {
    if (cacheConversations.length === 0) {
      log('Cache is empty');
      return;
    }

    const confirmMsg = `确定要清空所有 ${cacheConversations.length} 个缓存会话吗？此操作不可恢复。`;
    if (!confirm(confirmMsg)) return;

    try {
      await new Promise(resolve => {
        chrome.runtime.sendMessage({
          type: 'CLEAR_CACHE'
        }, resolve);
      });

      selectedConversationIds.clear();
      log('Cache cleared');

      await loadCacheConversations();
      updateSelectedCount();

    } catch (error) {
      log('Clear cache error: ' + error.message);
    }
  }

  function handleImportFile(file) {
    if (!file) return;

    const reader = new FileReader();
    reader.onload = async (e) => {
      try {
        const data = JSON.parse(e.target.result);

        if (!data.conversations || !Array.isArray(data.conversations)) {
          throw new Error('Invalid backup file format');
        }

        log('Importing ' + data.conversations.length + ' conversations...');

        const result = await new Promise(resolve => {
          chrome.runtime.sendMessage({
            type: 'IMPORT_CACHE_DATA',
            data: data
          }, resolve);
        });

        if (result && result.success) {
          log(`Import completed: ${result.imported} new, ${result.existing} existing`);
          statusEl.className = 'status detected';
          statusEl.textContent = 'Import successful!';
          await loadCacheConversations();
        } else {
          throw new Error(result?.error || 'Import failed');
        }

      } catch (error) {
        log('Import error: ' + error.message);
        statusEl.className = 'status error';
        statusEl.textContent = 'Import failed: ' + error.message;
      }
    };
    reader.readAsText(file);
  }

  let searchTimeout = null;
  searchInput.addEventListener('input', () => {
    if (searchTimeout) clearTimeout(searchTimeout);
    searchTimeout = setTimeout(() => {
      currentFilter.query = searchInput.value.trim();
      selectedConversationIds.clear();
      loadCacheConversations();
    }, 300);
  });

  platformFilter.addEventListener('change', () => {
    currentFilter.platform = platformFilter.value || null;
    selectedConversationIds.clear();
    loadCacheConversations();
  });

  selectAllCheckbox.addEventListener('change', () => {
    if (selectAllCheckbox.checked) {
      cacheConversations.forEach(conv => selectedConversationIds.add(conv.id));
    } else {
      selectedConversationIds.clear();
    }
    renderConversationList();
  });

  exportBtn.addEventListener('click', exportConversation);
  saveToCacheBtn.addEventListener('click', saveCurrentToCache);
  refreshBtn.addEventListener('click', async () => {
    log('Refreshing detection...');
    await detectPlatform();
  });

  ['optTimestamp', 'optModel', 'optReferences', 'optReasoning'].forEach(function(id) {
    document.getElementById(id).addEventListener('change', saveSettings);
  });

  batchExportBtn.addEventListener('click', batchExport);
  batchDeleteBtn.addEventListener('click', batchDelete);
  exportAllBtn.addEventListener('click', exportAllCache);
  clearCacheBtn.addEventListener('click', clearAllCache);

  importFileInput.addEventListener('change', (e) => {
    const file = e.target.files[0];
    if (file) {
      handleImportFile(file);
    }
    e.target.value = '';
  });

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

  log('Popup loaded (v2.0)');
  await loadSettings();
  await detectPlatform();
});

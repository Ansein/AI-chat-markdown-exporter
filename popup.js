// popup.js - Popup 界面逻辑
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

  // 添加日志
  function log(message) {
    const item = document.createElement('div');
    item.className = 'log-item';
    item.textContent = `[${new Date().toLocaleTimeString()}] ${message}`;
    logEl.appendChild(item);
    logEl.scrollTop = logEl.scrollHeight;
  }

  // 获取当前标签页
  async function getCurrentTab() {
    const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
    return tab;
  }

  async function ensureContentScriptReady(tabId) {
    try {
      return await chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_INFO' });
    } catch (error) {
      if (!error.message?.includes('Receiving end does not exist')) {
        throw error;
      }

      log('页面脚本未连接，正在尝试重新注入...');
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js']
      });

      await new Promise(resolve => setTimeout(resolve, 300));
      return await chrome.tabs.sendMessage(tabId, { type: 'GET_PAGE_INFO' });
    }
  }

  async function sendTabMessageWithRetry(tabId, payload) {
    try {
      return await chrome.tabs.sendMessage(tabId, payload);
    } catch (error) {
      if (!error.message?.includes('Receiving end does not exist')) {
        throw error;
      }

      log('检测到页面接收端丢失，正在补注入后重试...');
      await chrome.scripting.executeScript({
        target: { tabId },
        files: ['content.js']
      });

      await new Promise(resolve => setTimeout(resolve, 300));
      return await chrome.tabs.sendMessage(tabId, payload);
    }
  }

  // 检测平台
  async function detectPlatform() {
    try {
      const tab = await getCurrentTab();
      const url = tab.url;

      log('检测平台: ' + url);

      if (url.includes('chatgpt.com') || url.includes('chat.openai.com')) {
        currentPlatform = 'chatgpt';
        statusEl.className = 'status detected';
        statusEl.textContent = '✓ 已检测：ChatGPT';
        exportBtn.disabled = false;
        log('ChatGPT 平台已识别');
      } else if (url.includes('claude.ai') || url.includes('anthropic.com')) {
        currentPlatform = 'claude';
        statusEl.className = 'status detected';
        statusEl.textContent = '✓ 已检测：Claude';
        exportBtn.disabled = false;
        log('Claude 平台已识别');
      } else {
        currentPlatform = 'unknown';
        statusEl.className = 'status unknown';
        statusEl.textContent = '⚠ 未识别的平台 - 将尝试通用提取';
        exportBtn.disabled = false; // 仍然允许尝试通用提取
        log('未识别的平台，将使用通用提取方式');
      }

      // 获取页面信息
      try {
        const response = await ensureContentScriptReady(tab.id);
        log('页面信息：' + JSON.stringify(response));
      } catch (err) {
        log('无法获取页面信息：' + err.message);
      }

    } catch (error) {
      statusEl.className = 'status error';
      statusEl.textContent = '✕ 检测失败：' + error.message;
      log('检测错误：' + error.message);
    }
  }

  // 导出会话
  async function exportConversation() {
    try {
      const tab = await getCurrentTab();
      exportBtn.disabled = true;
      progressEl.style.display = 'block';
      progressFill.style.width = '20%';
      log('开始导出会话...');

      // 发送导出请求到 content script
      const result = await sendTabMessageWithRetry(tab.id, {
        type: 'EXPORT_CURRENT_CONVERSATION',
        platform: currentPlatform
      });

      progressFill.style.width = '60%';
      log('数据提取完成：' + (result.messages?.length || 0) + ' 条消息');

      if (result.error) {
        throw new Error(result.error);
      }

      // 获取设置
      const settings = {
        includeTimestamp: document.getElementById('optTimestamp').checked,
        includeModelInfo: document.getElementById('optModel').checked,
        includeReferences: document.getElementById('optReferences').checked,
        includeReasoningSummary: document.getElementById('optReasoning').checked,
        format: 'markdown',
        filenameTemplate: '{title}_{timestamp}.md',
      };

      // 发送到 background 进行处理和下载
      const exportResult = await new Promise((resolve) => {
        chrome.runtime.sendMessage({
          type: 'EXPORT_REQUEST',
          data: {
            conversation: result,
            settings: settings
          }
        }, resolve);
      });

      progressFill.style.width = '100%';

      if (exportResult.success) {
        statusEl.className = 'status detected';
        statusEl.textContent = '✓ 导出成功！';
        log('导出成功：' + exportResult.filename);
        if (exportResult.localPath) {
          log('保存位置：' + exportResult.localPath);
        } else if (exportResult.downloadId) {
          log('下载任务 ID：' + exportResult.downloadId);
        }

        // 更新消息计数
        messageCountEl.textContent = `已导出 ${result.messages?.length || 0} 条消息`;
      } else {
        throw new Error(exportResult.error);
      }

    } catch (error) {
      statusEl.className = 'status error';
      statusEl.textContent = '✕ 导出失败：' + error.message;
      log('导出错误：' + error.message);
    } finally {
      exportBtn.disabled = false;
      setTimeout(() => {
        progressEl.style.display = 'none';
        progressFill.style.width = '0%';
      }, 1000);
    }
  }

  // 加载保存的设置
  async function loadSettings() {
    try {
      const result = await new Promise((resolve) => {
        chrome.runtime.sendMessage({ type: 'GET_EXPORT_SETTINGS' }, resolve);
      });

      if (result) {
        document.getElementById('optTimestamp').checked = result.includeTimestamp !== false;
        document.getElementById('optModel').checked = result.includeModelInfo !== false;
        document.getElementById('optReferences').checked = result.includeReferences !== false;
        document.getElementById('optReasoning').checked = result.includeReasoningSummary !== false;
      }
    } catch (err) {
      log('加载设置失败：' + err.message);
    }
  }

  // 保存设置
  function saveSettings() {
    const settings = {
      includeTimestamp: document.getElementById('optTimestamp').checked,
      includeModelInfo: document.getElementById('optModel').checked,
      includeReferences: document.getElementById('optReferences').checked,
      includeReasoningSummary: document.getElementById('optReasoning').checked,
    };

    chrome.runtime.sendMessage({
      type: 'SAVE_EXPORT_SETTINGS',
      settings: settings
    });
  }

  // 事件监听
  exportBtn.addEventListener('click', exportConversation);
  refreshBtn.addEventListener('click', async () => {
    log('刷新检测...');
    await detectPlatform();
  });

  // 选项变化时保存
  ['optTimestamp', 'optModel', 'optReferences', 'optReasoning'].forEach(id => {
    document.getElementById(id).addEventListener('change', saveSettings);
  });

  // 监听来自 background 的消息
  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    if (message.type === 'PAGE_DATA_CAPTURED') {
      const data = message.data;
      if (data.messages) {
        capturedMessages = data.messages;
        messageCountEl.textContent = `已捕获 ${capturedMessages.length} 条消息`;
        log('新消息已捕获');
      }
    }
  });

  // 初始化
  log('Popup 已加载');
  await loadSettings();
  await detectPlatform();
});

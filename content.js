// content.js - Content Script for AI Session Export Tool
// 注入到页面中，负责数据采集和与后台脚本通信

(function() {
  'use strict';

  console.log('[AI Export] Content script initializing...');

  let currentPlatform = null;
  let platformConfig = null;

  function injectScript(src) {
    return new Promise((resolve, reject) => {
      const script = document.createElement('script');
      script.src = chrome.runtime.getURL(src);
      script.onload = function() {
        this.remove();
        resolve();
      };
      script.onerror = function() {
        console.error('[AI Export] Failed to load script:', src);
        this.remove();
        reject(new Error(`Failed to load script: ${src}`));
      };
      (document.head || document.documentElement).appendChild(script);
    });
  }

  async function injectAllScripts() {
    try {
      console.log('[AI Export] Injecting core scripts...');

      await injectScript('core/platforms/platformManager.js');
      await injectScript('core/utils/htmlToMarkdown.js');

      await injectScript('core/platforms/chatgpt.js');
      await injectScript('core/platforms/claude.js');
      await injectScript('core/platforms/yiyan.js');
      await injectScript('core/platforms/xinghuo.js');
      await injectScript('core/platforms/tongyi.js');
      await injectScript('core/platforms/doubao.js');

      await injectScript('injected.js');

      console.log('[AI Export] All scripts injected successfully');
    } catch (error) {
      console.error('[AI Export] Script injection failed:', error);
    }
  }

  injectAllScripts();

  window.addEventListener('AIExportData', (event) => {
    console.log('[AI Export] Received data from page:', event.detail?.type);

    chrome.runtime.sendMessage({
      type: 'PAGE_DATA_CAPTURED',
      data: event.detail
    }).catch(err => {
      console.warn('[AI Export] Failed to send message to background:', err);
    });
  });

  chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log('[AI Export] Content script received:', message.type);

    switch (message.type) {
      case 'EXPORT_CURRENT_CONVERSATION':
        exportCurrentConversation(message.platform)
          .then(data => sendResponse(data))
          .catch(err => sendResponse({ error: err.message }));
        return true;

      case 'GET_PAGE_INFO':
        sendResponse(getPageInfo());
        return true;

      case 'EXTRACT_CONVERSATION_LIST':
        extractConversationList()
          .then(data => sendResponse(data))
          .catch(err => sendResponse({ error: err.message }));
        return true;

      case 'GET_PLATFORM_CONFIG':
        sendResponse(getPlatformConfig());
        return true;

      default:
        sendResponse({ error: 'Unknown message type' });
    }
  });

  function getPageInfo() {
    const url = window.location.href;
    const detected = detectPlatform(url);

    return {
      url: url,
      platform: detected?.name || 'unknown',
      platformName: detected?.displayName || '未知平台',
      title: document.title,
      platformConfig: detected,
    };
  }

  function detectPlatform(url) {
    if (!url) return null;

    const platformPatterns = {
      chatgpt: {
        patterns: ['chatgpt.com', 'chat.openai.com'],
        name: 'chatgpt',
        displayName: 'ChatGPT'
      },
      claude: {
        patterns: ['claude.ai', 'anthropic.com'],
        name: 'claude',
        displayName: 'Claude'
      },
      yiyan: {
        patterns: ['yiyan.baidu.com', 'yiyan.baidu.com.cn'],
        name: 'yiyan',
        displayName: '文心一言'
      },
      xinghuo: {
        patterns: ['xinghuo.xfyun.cn', 'sparkdesk.xfyun.cn'],
        name: 'xinghuo',
        displayName: '讯飞星火'
      },
      tongyi: {
        patterns: ['tongyi.aliyun.com', 'qianwen.aliyun.com'],
        name: 'tongyi',
        displayName: '通义千问'
      },
      doubao: {
        patterns: ['doubao.com'],
        name: 'doubao',
        displayName: '豆包'
      },
    };

    for (const [key, platform] of Object.entries(platformPatterns)) {
      if (platform.patterns.some(p => url.includes(p))) {
        currentPlatform = platform.name;
        platformConfig = platform;
        return platform;
      }
    }

    return null;
  }

  function getPlatformConfig() {
    return platformConfig || detectPlatform(window.location.href);
  }

  async function exportCurrentConversation(platformName) {
    const pageInfo = getPageInfo();
    let data;

    const platform = platformName || pageInfo.platform;

    switch (platform) {
      case 'chatgpt':
        data = await extractDataWithPlatform('ChatGPTPlatform');
        break;
      case 'claude':
        data = await extractDataWithPlatform('ClaudePlatform');
        break;
      case 'yiyan':
        data = await extractDataWithPlatform('YiYanPlatform');
        break;
      case 'xinghuo':
        data = await extractDataWithPlatform('XingHuoPlatform');
        break;
      case 'tongyi':
        data = await extractDataWithPlatform('TongYiPlatform');
        break;
      case 'doubao':
        data = await extractDataWithPlatform('DouBaoPlatform');
        break;
      default:
        data = await extractDataFromDOM();
    }

    if (!data || !data.messages?.length) {
      console.warn('[AI Export] Platform-specific extraction failed, using DOM fallback');
      data = await extractDataFromDOM();
    }

    return {
      platform: pageInfo.platform,
      platformName: pageInfo.platformName,
      url: pageInfo.url,
      title: extractTitleFromPage(),
      ...data,
      exportedAt: new Date().toISOString()
    };
  }

  async function extractDataWithPlatform(platformGlobalName) {
    console.log(`[AI Export] Extracting data with ${platformGlobalName}...`);

    const platform = window[platformGlobalName];
    if (!platform) {
      console.warn(`[AI Export] Platform ${platformGlobalName} not found, falling back to DOM extraction`);
      return null;
    }

    try {
      return await platform.extractData();
    } catch (error) {
      console.error(`[AI Export] Failed to extract data from ${platformGlobalName}:`, error);
      return null;
    }
  }

  async function extractConversationList() {
    console.log('[AI Export] Extracting conversation list...');

    const pageInfo = getPageInfo();
    const platformName = pageInfo.platform;

    let platformGlobalName = null;
    switch (platformName) {
      case 'chatgpt': platformGlobalName = 'ChatGPTPlatform'; break;
      case 'claude': platformGlobalName = 'ClaudePlatform'; break;
      case 'yiyan': platformGlobalName = 'YiYanPlatform'; break;
      case 'xinghuo': platformGlobalName = 'XingHuoPlatform'; break;
      case 'tongyi': platformGlobalName = 'TongYiPlatform'; break;
      case 'doubao': platformGlobalName = 'DouBaoPlatform'; break;
    }

    if (!platformGlobalName) {
      return {
        success: false,
        error: 'Unknown platform',
        conversations: []
      };
    }

    const platform = window[platformGlobalName];
    if (!platform || !platform.extractConversationList) {
      return {
        success: false,
        error: 'Platform does not support conversation list extraction',
        conversations: []
      };
    }

    try {
      const conversations = await platform.extractConversationList();
      return {
        success: true,
        platform: platformName,
        conversations
      };
    } catch (error) {
      console.error('[AI Export] Failed to extract conversation list:', error);
      return {
        success: false,
        error: error.message,
        conversations: []
      };
    }
  }

  async function extractDataFromDOM() {
    console.log('[AI Export] Using DOM fallback extraction...');

    const messages = [];

    const containers = document.querySelectorAll('[class*="message"], [class*="conversation"], [class*="chat"], article, section');

    let userMessageCount = 0;
    let assistantMessageCount = 0;

    containers.forEach((container, index) => {
      if (container.parentElement?.closest('[class*="message"]')) {
        return;
      }

      try {
        const text = container.textContent?.trim();
        if (!text || text.length < 10) return;

        const isUser = isUserElement(container);

        const message = {
          id: `msg-${index}`,
          role: isUser ? 'user' : 'assistant',
          contentText: text,
          contentHtml: container.innerHTML,
          contentMarkdown: window.HtmlToMarkdown?.convert?.(container.innerHTML) || '',
          createdAt: extractTimestampFromElement(container),
        };

        if (message.role === 'user') {
          userMessageCount++;
        } else {
          assistantMessageCount++;
        }

        messages.push(message);
      } catch (err) {
        console.error('[AI Export] Failed to extract from container:', err);
      }
    });

    return {
      messages: sortMessagesByOrder(messages),
    };
  }

  function isUserElement(element) {
    const className = (element.className || '').toLowerCase();

    const userClasses = ['user', 'my', 'question', 'left', 'send', 'self', 'me'];
    const assistantClasses = ['ai', 'bot', 'assistant', 'answer', 'response', 'right', 'receive', 'other'];

    for (const cls of userClasses) {
      if (className.includes(cls)) return true;
    }

    for (const cls of assistantClasses) {
      if (className.includes(cls)) return false;
    }

    const dataRole = element.getAttribute('data-role') || element.getAttribute('data-type');
    if (dataRole) {
      return dataRole.toLowerCase() === 'user';
    }

    return false;
  }

  function extractTimestampFromElement(element) {
    const timeEl = element.querySelector('time, [data-time], [data-timestamp], [class*="time"]');
    if (timeEl) {
      return timeEl.getAttribute('datetime') ||
             timeEl.getAttribute('data-time') ||
             timeEl.getAttribute('data-timestamp') ||
             timeEl.textContent;
    }
    return null;
  }

  function sortMessagesByOrder(messages) {
    return messages;
  }

  function extractTitleFromPage() {
    const currentPath = window.location.pathname;

    const conversationLinkSelectors = [
      `a[href="${currentPath}"]`,
      `a[href$="${currentPath}"]`,
      `a[aria-current="page"][href*="/c/"]`,
      `nav a[href*="/c/"][aria-current="page"]`,
      `aside a[href*="/c/"][aria-current="page"]`,
      `a[data-testid*="conversation"][href*="/c/"]`,
      `[data-conversation-title]`,
    ];

    for (const selector of conversationLinkSelectors) {
      try {
        const el = document.querySelector(selector);
        const text = normalizeInlineText(el?.textContent || '');
        if (text && text.toLowerCase() !== 'chatgpt' && text.length > 0) {
          return text;
        }
      } catch (e) {}
    }

    const cleanedDocumentTitle = cleanConversationTitle(document.title);
    if (cleanedDocumentTitle) {
      return cleanedDocumentTitle;
    }

    const titleSelectors = [
      '[data-conversation-title]',
      'header h1',
      '[class*="title"]',
      'title',
    ];

    for (const selector of titleSelectors) {
      try {
        const el = document.querySelector(selector);
        if (el) {
          const text = cleanConversationTitle(el.textContent?.trim() || '');
          if (text) return text;
        }
      } catch (e) {}
    }

    return '未命名会话';
  }

  function normalizeInlineText(text) {
    return text
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\s+([,.;:!?])/g, '$1')
      .trim();
  }

  function cleanConversationTitle(rawTitle) {
    if (!rawTitle) return '';

    const normalized = rawTitle.replace(/\s+/g, ' ').trim();
    if (!normalized) return '';

    const parts = normalized.split(/\s+-\s+/).map(part => part.trim()).filter(Boolean);
    const filtered = parts.filter(part => !/^chatgpt$/i.test(part));
    if (filtered.length === 0) {
      return normalized === 'ChatGPT' ? '' : normalized;
    }

    return filtered[filtered.length - 1];
  }

  console.log('[AI Export] Content script initialized, platform:', getPageInfo().platform);

})();

// content.js - Content Script for AI Session Export Tool

// 注入脚本到页面上下文
function injectScript() {
  var script = document.createElement('script');
  script.src = chrome.runtime.getURL('injected.js');
  script.onload = function() {
    this.remove();
  };
  (document.head || document.documentElement).appendChild(script);
}

injectScript();

// 监听来自 injected.js 的消息
window.addEventListener('AIExportData', function(event) {
  console.log('[AI Export] Received data from page:', event.detail && event.detail.type);

  chrome.runtime.sendMessage({
    type: 'PAGE_DATA_CAPTURED',
    data: event.detail
  }).catch(function(err) {
    console.warn('[AI Export] Failed to send message to background:', err);
  });
});

// 监听来自 popup 或 background 的消息
chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
  console.log('[AI Export] Content script received:', message.type);

  switch (message.type) {
    case 'EXPORT_CURRENT_CONVERSATION':
      exportCurrentConversation(message.platform)
        .then(function(data) { sendResponse(data); })
        .catch(function(err) { sendResponse({ error: err.message }); });
      return true;

    case 'GET_PAGE_INFO':
      sendResponse(getPageInfo());
      return true;

    default:
      sendResponse({ error: 'Unknown message type' });
  }
});

// 获取页面信息
function getPageInfo() {
  var url = window.location.href;
  var platform = 'unknown';

  if (url.indexOf('chatgpt.com') !== -1 || url.indexOf('chat.openai.com') !== -1) {
    platform = 'chatgpt';
  } else if (url.indexOf('claude.ai') !== -1 || url.indexOf('anthropic.com') !== -1) {
    platform = 'claude';
  }

  return { url: url, platform: platform, title: document.title };
}

// 导出当前会话的主入口函数
async function exportCurrentConversation(platform) {
  var pageInfo = getPageInfo();
  var data;

  switch (platform) {
    case 'chatgpt':
      data = await extractChatGPTData();
      break;
    case 'claude':
      data = await extractClaudeData();
      break;
    default:
      data = await extractDataFromDOM();
  }

  if (!data || !data.messages || data.messages.length === 0) {
    console.warn('[AI Export] Platform-specific extraction failed, using DOM fallback');
    data = await extractDataFromDOM();
  }

  return Object.assign({
    platform: pageInfo.platform,
    url: pageInfo.url,
    title: extractTitleFromPage()
  }, data, {
    exportedAt: new Date().toISOString()
  });
}

// ========== ChatGPT 提取 ==========
async function extractChatGPTData() {
  console.log('[AI Export] Extracting ChatGPT data...');

  await waitForElement('[data-message-author-role]', 3000).catch(function() {});

  var messages = [];
  var messageElements = document.querySelectorAll('[data-message-author-role]');

  messageElements.forEach(function(el, index) {
    try {
      var role = el.getAttribute('data-message-author-role');
      var contentEl = el.querySelector('[data-message-content]') || el;
      var timestamp = extractTimestamp(el);
      var model = extractModel(el);

      messages.push({
        id: 'msg-' + index,
        role: role === 'user' ? 'user' : 'assistant',
        createdAt: timestamp,
        model: model,
        contentHtml: contentEl.innerHTML,
        contentText: contentEl.textContent,
        contentMarkdown: htmlToMarkdownSimple(contentEl.innerHTML),
        citations: extractCitations(el),
      });
    } catch (err) {
      console.error('[AI Export] Failed to extract message:', err);
    }
  });

  var globalData = window.__CHATGPT_DATA__ || {};

  return {
    messages: messages,
    model: globalData.model,
    createTime: globalData.createTime,
    meta: globalData
  };
}

// ========== Claude 提取 ==========
async function extractClaudeData() {
  console.log('[AI Export] Extracting Claude data...');

  // 优先：使用 API 拦截数据（由 injected.js 捕获）
  var apiData = window.__AI_EXPORT__ ? window.__AI_EXPORT__.getData() : null;
  if (apiData && apiData.messages && apiData.messages.length > 0) {
    console.log('[AI Export] Using API-intercepted data:', apiData.messages.length, 'messages');
    return {
      messages: apiData.messages,
      model: apiData.metadata && apiData.metadata.model,
      createTime: apiData.metadata && apiData.metadata.createTime,
      meta: apiData.metadata || {}
    };
  }

  // 兜底：DOM 提取
  console.log('[AI Export] No API data available, falling back to DOM extraction');
  return extractClaudeDataFromDOM();
}

async function extractClaudeDataFromDOM() {
  console.log('[AI Export] Extracting Claude data from DOM...');

  // 等待页面加载完成
  await waitForElement('[data-testid="user-message"], .font-claude-response', 5000).catch(function() {});

  // 收集所有消息元素
  var allElements = [];

  // 用户消息
  var userElements = document.querySelectorAll('[data-testid="user-message"]');
  userElements.forEach(function(el) {
    allElements.push({ el: el, type: 'user' });
  });

  // AI 消息
  var assistantElements = document.querySelectorAll('.font-claude-response');
  assistantElements.forEach(function(el) {
    allElements.push({ el: el, type: 'assistant' });
  });

  // 按文档顺序排序
  allElements = sortByDocumentOrder(allElements.map(function(item) { return item.el; }))
    .map(function(el) {
      return allElements.find(function(item) { return item.el === el; });
    });

  var messages = [];
  allElements.forEach(function(item, index) {
    try {
      var msg = extractClaudeMessageFromElement(item.el, item.type, index);
      if (msg) messages.push(msg);
    } catch (err) {
      console.error('[AI Export] Failed to extract Claude message:', err);
    }
  });

  // 如果 DOM 提取也没找到，尝试通用兜底
  if (messages.length === 0) {
    console.warn('[AI Export] No messages found with known selectors, trying generic extraction');
    messages = extractClaudeMessagesGeneric();
  }

  return { messages: messages };
}

// 按文档顺序排序元素
function sortByDocumentOrder(elements) {
  return Array.from(elements).sort(function(a, b) {
    var pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  });
}

// 从单个元素提取 Claude 消息
function extractClaudeMessageFromElement(el, type, index) {
  var message = {
    id: 'msg-' + index,
    role: type === 'user' ? 'user' : 'assistant'
  };

  if (type === 'user') {
    // 用户消息：直接从 [data-testid="user-message"] 提取
    var contentText = el.textContent ? el.textContent.trim() : '';
    message.contentText = contentText;
    message.contentHtml = el.innerHTML;
    message.contentMarkdown = htmlToMarkdownSimple(el.innerHTML);

    // 文件附件
    var attachments = [];
    var fileThumbnails = el.querySelectorAll('[data-testid="file-thumbnail"]');
    fileThumbnails.forEach(function(ft) {
      attachments.push({
        name: ft.textContent ? ft.textContent.trim() : (ft.getAttribute('data-file-name') || 'attachment')
      });
    });
    if (attachments.length > 0) message.attachments = attachments;

  } else {
    // AI 消息：从 .font-claude-response 提取
    var proseEl = el.querySelector('div[class*="prose"]') || el;

    message.contentHtml = proseEl.innerHTML;
    message.contentText = proseEl.textContent ? proseEl.textContent.trim() : '';
    message.contentMarkdown = htmlToMarkdownSimple(proseEl.innerHTML);

    // 提取思考过程
    var turnContainer = el.closest('[data-test-render-count]') || el.parentElement;
    if (turnContainer) {
      var thinkingSelectors = [
        '[class*="thinking"]',
        '[class*="reasoning"]',
        'details'
      ];
      for (var i = 0; i < thinkingSelectors.length; i++) {
        var thinkingEl = turnContainer.querySelector(thinkingSelectors[i]);
        if (thinkingEl) {
          // 如果是 <details> 元素，获取展开后的内容
          if (thinkingEl.tagName.toLowerCase() === 'details') {
            // 获取 <details> 中除了 <summary> 之外的的内容
            var summary = thinkingEl.querySelector('summary');
            var detailsContent = thinkingEl.innerHTML;
            if (summary) {
              // 移除 summary 内容
              detailsContent = thinkingEl.innerHTML.replace(summary.outerHTML, '');
            }
            var tempDiv = document.createElement('div');
            tempDiv.innerHTML = detailsContent;
            message.reasoning_summary = tempDiv.textContent ? tempDiv.textContent.trim() : null;
          } else {
            message.reasoning_summary = thinkingEl.textContent ? thinkingEl.textContent.trim() : null;
          }
          break;
        }
      }
    }

    // 提取引用
    message.citations = extractCitations(el);
  }

  return message;
}

// 通用 Claude 消息提取（兜底）
function extractClaudeMessagesGeneric() {
  var messages = [];

  // 尝试在 [role="main"] 中找消息
  var mainEl = document.querySelector('[role="main"]');
  if (!mainEl) return messages;

  // 找所有段落，用启发式判断角色
  var allBlocks = mainEl.querySelectorAll('p, div[class*="prose"], [class*="message"], [class*="response"]');
  var lastRole = null;

  allBlocks.forEach(function(el, index) {
    var text = el.textContent ? el.textContent.trim() : '';
    if (text.length < 10) return;

    // 判断角色：如果有反馈按钮则是 AI 消息
    var hasFeedback = !!el.closest('article, div')?.querySelector('button[aria-label*="feedback"]');
    var role = hasFeedback ? 'assistant' : (lastRole === 'assistant' ? 'user' : 'user');

    // 交替模式：如果连续两个相同角色，重新判断
    if (role === lastRole) {
      role = role === 'user' ? 'assistant' : 'user';
    }

    messages.push({
      id: 'msg-' + index,
      role: role,
      contentText: text,
      contentHtml: el.innerHTML,
      contentMarkdown: htmlToMarkdownSimple(el.innerHTML)
    });

    lastRole = role;
  });

  return messages;
}

// ========== 通用 DOM 提取（兜底） ==========
async function extractDataFromDOM() {
  console.log('[AI Export] Using DOM fallback extraction...');

  var messages = [];

  // 策略：直接找消息级别的最小单元，而非外层容器
  var allElements = document.querySelectorAll(
    'article, [role="article"], [class*="message"], [class*="prompt"], ' +
    '[class*="response"], [class*="assistant"], [class*="human"], ' +
    '[class*="user-bubble"], [class*="ai-bubble"], [class*="chat-message"], ' +
    '[data-role], [data-sender]'
  );

  // 去重：只保留最深层的消息元素
  var leafMessages = [];
  allElements.forEach(function(el) {
    var hasNested = false;
    el.querySelectorAll('article, [role="article"], [class*="message"], [class*="prompt"], [class*="response"], [class*="assistant"], [class*="human"]').forEach(function(nested) {
      if (nested !== el) hasNested = true;
    });
    if (!hasNested) leafMessages.push(el);
  });

  if (leafMessages.length === 0) {
    leafMessages = Array.from(allElements);
  }

  // 去重
  var uniqueElements = [];
  var seen = new Set();
  leafMessages.forEach(function(el) {
    if (!seen.has(el)) {
      seen.add(el);
      uniqueElements.push(el);
    }
  });

  // 按文档顺序排序
  uniqueElements = sortByDocumentOrder(uniqueElements);

  uniqueElements.forEach(function(container, index) {
    try {
      var text = container.textContent ? container.textContent.trim() : '';
      if (!text || text.length < 10) return;

      // 跳过导航、侧边栏等区域
      if (isNonMessageArea(container)) return;

      var role = detectMessageRole(container);

      messages.push({
        id: 'msg-' + index,
        role: role,
        contentText: text,
        contentHtml: container.innerHTML,
        contentMarkdown: htmlToMarkdownSimple(container.innerHTML),
        citations: extractCitations(container)
      });
    } catch (err) {
      console.error('[AI Export] Failed to extract from container:', err);
    }
  });

  // 去重和角色修正
  if (messages.length > 0) {
    messages = deduplicateAndFixRoles(messages);
  }

  return { messages: messages };
}

// 判断元素是否位于非消息区域（导航、侧边栏等）
function isNonMessageArea(el) {
  var parent = el.parentElement;
  while (parent) {
    var tag = parent.tagName.toLowerCase();
    var cls = parent.className || '';
    if (tag === 'nav' || tag === 'header' || tag === 'footer') return true;
    if (typeof cls === 'string') {
      var clsLower = cls.toLowerCase();
      if (clsLower.indexOf('sidebar') !== -1 || clsLower.indexOf('navigation') !== -1 ||
          clsLower.indexOf('menu') !== -1 || clsLower.indexOf('toolbar') !== -1) return true;
    }
    parent = parent.parentElement;
  }
  return false;
}

// 检测消息角色
function detectMessageRole(el) {
  // 1. 检查 data 属性
  var dataRole = el.getAttribute('data-role');
  var dataSender = el.getAttribute('data-sender');
  if (dataRole) {
    var r = dataRole.toLowerCase();
    if (r.indexOf('user') !== -1 || r.indexOf('human') !== -1) return 'user';
    if (r.indexOf('assistant') !== -1 || r.indexOf('ai') !== -1 || r.indexOf('bot') !== -1) return 'assistant';
  }
  if (dataSender) {
    var s = dataSender.toLowerCase();
    if (s === 'human' || s === 'user') return 'user';
    if (s === 'assistant' || s === 'ai' || s === 'bot') return 'assistant';
  }

  // 2. 检查 class
  var cls = (el.className || '').toLowerCase();
  if (cls.indexOf('user') !== -1 && cls.indexOf('assistant') === -1) return 'user';
  if (cls.indexOf('human') !== -1 && cls.indexOf('assistant') === -1) return 'user';
  if (cls.indexOf('prompt') !== -1 && cls.indexOf('response') === -1) return 'user';
  if (cls.indexOf('assistant') !== -1 || cls.indexOf('ai-bubble') !== -1 || cls.indexOf('bot-') !== -1) return 'assistant';
  if (cls.indexOf('response') !== -1 || cls.indexOf('ai-') !== -1) return 'assistant';

  // 3. 检查内部是否有明确的用户/AI标识元素
  var hasUserIndicator = !!el.querySelector('[class*="user-avatar"], [class*="user-icon"], [class*="human-avatar"], [data-role="user"], [data-sender="user"], [data-sender="human"]');
  var hasAssistantIndicator = !!el.querySelector('[class*="assistant-avatar"], [class*="ai-avatar"], [class*="bot-avatar"], [data-role="assistant"], [data-sender="assistant"], [data-sender="ai"]');

  if (hasUserIndicator && !hasAssistantIndicator) return 'user';
  if (hasAssistantIndicator && !hasUserIndicator) return 'assistant';

  // 4. 检查是否有典型的AI特征
  var hasCodeBlocks = el.querySelectorAll('pre, code').length > 0;
  var hasLinks = el.querySelectorAll('a[href^="http"]').length > 2;
  var hasBlockquote = el.querySelectorAll('blockquote').length > 0;

  if (hasCodeBlocks || hasLinks || hasBlockquote) return 'assistant';

  // 5. 检查文本特征
  var text = el.textContent ? el.textContent.trim() : '';
  var textLen = text.length;
  var hasLineBreaks = text.indexOf('\n') !== -1;

  if (textLen > 500 && hasLineBreaks) return 'assistant';

  // 6. 默认：简短、无特殊格式 → 用户
  if (textLen < 200 && !hasCodeBlocks && !hasLinks) return 'user';

  return 'assistant';
}

// 去重和角色修正
function deduplicateAndFixRoles(messages) {
  // 去除重复内容
  var seen = new Set();
  var deduped = [];
  messages.forEach(function(msg) {
    var key = msg.contentText.slice(0, 100);
    if (!seen.has(key)) {
      seen.add(key);
      deduped.push(msg);
    }
  });

  // 如果所有消息都是同一角色，尝试用交替模式修正
  if (deduped.length > 1) {
    var allSame = true;
    var firstRole = deduped[0].role;
    for (var i = 1; i < deduped.length; i++) {
      if (deduped[i].role !== firstRole) { allSame = false; break; }
    }

    if (allSame) {
      deduped.forEach(function(msg, i) {
        msg.role = i % 2 === 0 ? 'user' : 'assistant';
      });
    }
  }

  return deduped;
}

// ========== 辅助函数 ==========

function extractTimestamp(element) {
  var timeEl = element.querySelector('time');
  if (timeEl) {
    return timeEl.getAttribute('datetime') || timeEl.textContent;
  }
  var datetime = element.getAttribute('data-timestamp') || element.getAttribute('data-created-at');
  if (datetime) return datetime;
  return null;
}

function extractModel(element) {
  var modelEl = element.querySelector('[class*="model"], [data-model]');
  return modelEl ? (modelEl.getAttribute('data-model') || modelEl.textContent) : null;
}

function extractCitations(element) {
  var citations = [];
  var citationElements = element.querySelectorAll('a[href^="http"]');

  citationElements.forEach(function(cite, index) {
    var url = cite.getAttribute('href');
    if (url && url.indexOf('http') === 0) {
      citations.push({
        index: index + 1,
        url: url,
        title: cite.getAttribute('title') || (cite.textContent ? cite.textContent.slice(0, 100) : '')
      });
    }
  });

  return citations;
}

function extractTitleFromPage() {
  var currentPath = window.location.pathname;

  var conversationLinkSelectors = [
    'a[href="' + currentPath + '"]',
    'a[href$="' + currentPath + '"]',
    'a[aria-current="page"][href*="/c/"]',
    'nav a[href*="/c/"][aria-current="page"]',
    'aside a[href*="/c/"][aria-current="page"]',
    '[data-conversation-title]'
  ];

  for (var i = 0; i < conversationLinkSelectors.length; i++) {
    var el = document.querySelector(conversationLinkSelectors[i]);
    var text = el && el.textContent ? el.textContent.trim() : '';
    if (text && text.toLowerCase() !== 'chatgpt') {
      return text;
    }
  }

  if (document.title) {
    var parts = document.title.split(/\s+-\s+/);
    var filtered = parts.filter(function(p) { return p.trim().toLowerCase() !== 'chatgpt'; });
    if (filtered.length > 0) return filtered[filtered.length - 1].trim();
  }

  return '\u672a\u547d\u540d\u4f1a\u8bdd';
}

// 简单的 HTML 转 Markdown
function htmlToMarkdownSimple(html) {
  if (!html) return '';

  var temp = document.createElement('div');
  temp.innerHTML = html;

  // 清理 UI 杂质
  temp.querySelectorAll('button, svg, style, script, noscript, .sr-only, .screen-reader-only, [aria-hidden="true"]').forEach(function(el) {
    el.remove();
  });

  var markdown = serializeBlockChildren(temp).trim();
  return normalizeMarkdown(markdown);
}

function serializeBlockChildren(root) {
  var result = '';
  root.childNodes.forEach(function(node) {
    result += serializeNode(node, false);
  });
  return result;
}

function serializeNode(node, inlineContext) {
  if (node.nodeType === Node.TEXT_NODE) {
    return inlineContext ? normalizeInlineText(node.textContent || '') : (node.textContent || '');
  }

  if (node.nodeType !== Node.ELEMENT_NODE) return '';

  var el = node;
  var tag = el.tagName.toLowerCase();

  switch (tag) {
    case 'br':
      return inlineContext ? ' ' : '  \n';

    case 'pre': {
      var codeEl = el.querySelector('code');
      var langClass = codeEl ? codeEl.className : '';
      var match = langClass.match(/language-([\w-]+)/);
      var lang = match ? match[1] : '';
      var codeText = serializePreformattedText(codeEl || el).replace(/\r/g, '').trimEnd();
      return '\n```' + lang + '\n' + codeText + '\n```\n\n';
    }

    case 'code':
      return '`' + normalizeInlineText(getVisibleText(el)) + '`';

    case 'strong':
    case 'b':
      return '**' + serializeInlineChildren(el) + '**';

    case 'em':
    case 'i':
      return '*' + serializeInlineChildren(el) + '*';

    case 'a': {
      var href = el.getAttribute('href') || '';
      var text = normalizeInlineText(getVisibleText(el)) || href;
      if (!href || href.indexOf('#') === 0 || href.indexOf('javascript:') === 0) return text;
      return '[' + text + '](' + href + ')';
    }

    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      var level = Number(tag[1]);
      var title = normalizeInlineText(getVisibleText(el));
      return '\n' + '#'.repeat(level) + ' ' + title + '\n\n';
    }

    case 'p': {
      var pText = serializeInlineChildren(el);
      return pText ? pText + '\n\n' : '';
    }

    case 'blockquote': {
      var bqText = normalizeMarkdown(serializeBlockChildren(el).trim());
      if (!bqText) return '';
      var quoted = bqText.split('\n').map(function(line) { return line ? '> ' + line : '>'; }).join('\n');
      return quoted + '\n\n';
    }

    case 'ul': {
      var items = Array.from(el.children).filter(function(child) { return child.tagName && child.tagName.toLowerCase() === 'li'; });
      if (!items.length) return '';
      var result = '';
      items.forEach(function(li) {
        result += '- ' + (li.textContent ? li.textContent.trim() : '') + '\n';
      });
      return result + '\n';
    }

    case 'ol': {
      var oItems = Array.from(el.children).filter(function(child) { return child.tagName && child.tagName.toLowerCase() === 'li'; });
      if (!oItems.length) return '';
      var oResult = '';
      oItems.forEach(function(li, idx) {
        oResult += (idx + 1) + '. ' + (li.textContent ? li.textContent.trim() : '') + '\n';
      });
      return oResult + '\n';
    }

    case 'table': {
      var rows = el.querySelectorAll('tr');
      var tMd = '\n';
      rows.forEach(function(tr, rowIndex) {
        var cells = Array.from(tr.querySelectorAll('th, td')).map(function(cell) {
          return (normalizeInlineText(getVisibleText(cell)).replace(/\|/g, '\\|') || ' ');
        });
        tMd += '| ' + cells.join(' | ') + ' |\n';
        if (rowIndex === 0) {
          tMd += '| ' + cells.map(function() { return '---'; }).join(' | ') + ' |\n';
        }
      });
      return tMd + '\n';
    }

    case 'hr':
      return '\n---\n\n';

    case 'div':
    case 'section':
    case 'article':
    case 'main': {
      if (hasBlockChildren(el)) return serializeBlockChildren(el);
      var dText = serializeInlineChildren(el);
      return dText ? dText + '\n\n' : '';
    }

    case 'span':
      return serializeInlineChildren(el);

    default: {
      if (hasBlockChildren(el)) return serializeBlockChildren(el);
      return serializeInlineChildren(el);
    }
  }
}

function serializeInlineChildren(root) {
  var result = '';
  root.childNodes.forEach(function(node) {
    result += serializeNode(node, true);
  });
  return normalizeInlineText(result);
}

function serializePreformattedText(root) {
  var parts = [];

  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent || '');
      return;
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return;

    var el = node;
    var tag = el.tagName.toLowerCase();
    if (tag === 'br') {
      parts.push('\n');
      return;
    }

    var children = Array.from(el.childNodes);
    children.forEach(function(child, index) {
      walk(child);
      if (child.nodeType === Node.ELEMENT_NODE) {
        var childEl = child;
        var childTag = childEl.tagName.toLowerCase();
        var shouldBreak = /^(div|p|li|tr)$/.test(childTag) ||
          /(line|code-line)/i.test(childEl.className || '') ||
          childEl.getAttribute('data-line') !== null;
        if (shouldBreak && index < children.length - 1) {
          if (!parts[parts.length - 1] || !parts[parts.length - 1].endsWith('\n')) {
            parts.push('\n');
          }
        }
      }
    });
  }

  walk(root);
  return parts.join('').replace(/\u00a0/g, ' ').replace(/\n{3,}/g, '\n\n');
}

function hasBlockChildren(el) {
  return Array.from(el.children).some(function(child) {
    return /^(div|section|article|main|p|pre|blockquote|ul|ol|table|h[1-6]|hr)$/i.test(child.tagName);
  });
}

function getVisibleText(el) {
  var text = typeof el.innerText === 'string' ? el.innerText : (el.textContent || '');
  return text.replace(/\u00a0/g, ' ');
}

function normalizeInlineText(text) {
  return text.replace(/\s+/g, ' ').replace(/\s+([,.;:!?])/g, '$1').trim();
}

function normalizeMarkdown(text) {
  return text.replace(/\r/g, '').replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
}

function waitForElement(selector, timeout) {
  if (timeout === undefined) timeout = 5000;
  return new Promise(function(resolve, reject) {
    var element = document.querySelector(selector);
    if (element) {
      resolve(element);
      return;
    }

    var observer = new MutationObserver(function() {
      var element = document.querySelector(selector);
      if (element) {
        observer.disconnect();
        resolve(element);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(function() {
      observer.disconnect();
      reject(new Error('Timeout waiting for ' + selector));
    }, timeout);
  });
}

console.log('[AI Export] Content script initialized, platform:', getPageInfo().platform);

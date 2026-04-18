// content.js - Content Script for AI Session Export Tool
// 注入到页面中，负责数据采集和与后台脚本通信

// 注入脚本到页面上下文（绕过 isolated world）
function injectScript() {
  const script = document.createElement('script');
  script.src = chrome.runtime.getURL('injected.js');
  script.onload = function() {
    this.remove();
  };
  (document.head || document.documentElement).appendChild(script);
}

// 立即注入
injectScript();

// 监听来自 injected.js 的消息
window.addEventListener('AIExportData', (event) => {
  console.log('[AI Export] Received data from page:', event.detail?.type);

  // 转发给 background.js
  chrome.runtime.sendMessage({
    type: 'PAGE_DATA_CAPTURED',
    data: event.detail
  }).catch(err => {
    console.warn('[AI Export] Failed to send message to background:', err);
  });
});

// 监听来自 popup 或 background 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[AI Export] Content script received:', message.type);

  switch (message.type) {
    case 'EXPORT_CURRENT_CONVERSATION':
      // 导出当前会话
      exportCurrentConversation(message.platform)
        .then(data => sendResponse(data))
        .catch(err => sendResponse({ error: err.message }));
      return true;

    case 'GET_PAGE_INFO':
      // 获取页面信息
      sendResponse(getPageInfo());
      return true;

    default:
      sendResponse({ error: 'Unknown message type' });
  }
});

// 获取页面信息
function getPageInfo() {
  const url = window.location.href;
  let platform = 'unknown';

  if (url.includes('chatgpt.com') || url.includes('chat.openai.com')) {
    platform = 'chatgpt';
  } else if (url.includes('claude.ai') || url.includes('anthropic.com')) {
    platform = 'claude';
  }

  return {
    url: url,
    platform: platform,
    title: document.title,
  };
}

// 导出当前会话的主入口函数
async function exportCurrentConversation(platform) {
  const pageInfo = getPageInfo();
  let data;

  // 根据平台选择提取策略
  switch (platform) {
    case 'chatgpt':
      data = await extractChatGPTData();
      break;
    case 'claude':
      data = await extractClaudeData();
      break;
    default:
      // 尝试通用 DOM 提取
      data = await extractDataFromDOM();
  }

  // 如果没有提取到数据，使用兜底方案
  if (!data || !data.messages?.length) {
    console.warn('[AI Export] Platform-specific extraction failed, using DOM fallback');
    data = await extractDataFromDOM();
  }

  // 合并信息
  return {
    platform: pageInfo.platform,
    url: pageInfo.url,
    title: extractTitleFromPage(),
    ...data,
    exportedAt: new Date().toISOString()
  };
}

// 从 ChatGPT 页面提取数据
async function extractChatGPTData() {
  console.log('[AI Export] Extracting ChatGPT data...');

  // 等待页面加载
  await waitForElement('[data-message-author-role]', 3000).catch(() => {});

  const messages = [];
  const messageElements = document.querySelectorAll('[data-message-author-role]');

  messageElements.forEach((el, index) => {
    try {
      const role = el.getAttribute('data-message-author-role');
      const contentEl = el.querySelector('[data-message-content]') || el;
      const timestamp = extractTimestamp(el);
      const model = extractModel(el);

      const message = {
        id: `msg-${index}`,
        role: role === 'user' ? 'user' : 'assistant',
        createdAt: timestamp,
        model: model,
        contentHtml: contentEl.innerHTML,
        contentText: contentEl.textContent,
        contentMarkdown: htmlToMarkdownSimple(contentEl.innerHTML),
        citations: extractCitations(el),
      };

      messages.push(message);
    } catch (err) {
      console.error('[AI Export] Failed to extract message:', err);
    }
  });

  // 尝试从全局对象获取更多数据
  const globalData = window.__CHATGPT_DATA__ || {};

  return {
    messages: messages,
    model: globalData.model,
    createTime: globalData.createTime,
    meta: globalData,
  };
}

// 从 Claude 页面提取数据

// ========== Claude 提取 ==========
async function extractClaudeData() {
  console.log('[AI Export] Extracting Claude data...');

  // 优先使用 API 拦截数据（由 injected.js 捕获）
  const apiData = window.__AI_EXPORT__?.getData?.();
  if (apiData?.messages?.length > 0) {
    console.log('[AI Export] Using API-intercepted data:', apiData.messages.length, 'messages');
    return { messages: apiData.messages, model: apiData.metadata?.model, meta: apiData.metadata || {} };
  }

  return extractClaudeDataFromDOM();
}

async function extractClaudeDataFromDOM() {
  console.log('[AI Export] Extracting Claude data from DOM...');
  await waitForElement('[data-testid="user-message"], .font-claude-response', 5000).catch(() => {});

  const allElements = [];
  document.querySelectorAll('[data-testid="user-message"]').forEach(el => allElements.push({ el, type: 'user' }));
  document.querySelectorAll('.font-claude-response').forEach(el => allElements.push({ el, type: 'assistant' }));

  const sortedElements = [...allElements.map(item => item.el)].sort((a, b) => {
    const pos = a.compareDocumentPosition(b);
    if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
    if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
    return 0;
  }).map(el => allElements.find(item => item.el === el));

  const messages = [];
  sortedElements.forEach((item, index) => {
    try {
      const msg = extractClaudeMessageFromElement(item.el, item.type, index);
      if (msg) messages.push(msg);
    } catch (err) { console.error('[AI Export] Failed to extract Claude message:', err); }
  });

  if (messages.length === 0) messages.push(...extractClaudeMessagesGeneric());
  return { messages };
}

function extractClaudeMessageFromElement(el, type, index) {
  const message = { id: `msg-${index}`, role: type === 'user' ? 'user' : 'assistant' };

  if (type === 'user') {
    message.contentText = el.textContent?.trim() || '';
    message.contentHtml = el.innerHTML;
    message.contentMarkdown = htmlToMarkdownSimple(el.innerHTML);
    const attachments = [];
    el.querySelectorAll('[data-testid="file-thumbnail"]').forEach(ft => {
      attachments.push({ name: ft.textContent?.trim() || ft.getAttribute('data-file-name') || 'attachment' });
    });
    if (attachments.length > 0) message.attachments = attachments;
  } else {
    const proseEl = el.querySelector('div[class*="prose"]') || el;
    message.contentHtml = proseEl.innerHTML;
    message.contentText = proseEl.textContent?.trim() || '';
    message.contentMarkdown = htmlToMarkdownSimple(proseEl.innerHTML);
    const turnContainer = el.closest('[data-test-render-count]') || el.parentElement;
    if (turnContainer) {
      const thinkingEl = turnContainer.querySelector('[class*="thinking"], [class*="reasoning"], details');
      if (thinkingEl) {
        if (thinkingEl.tagName.toLowerCase() === 'details') {
          const summary = thinkingEl.querySelector('summary');
          const dc = summary ? thinkingEl.innerHTML.replace(summary.outerHTML, '') : thinkingEl.innerHTML;
          const tempDiv = document.createElement('div');
          tempDiv.innerHTML = dc;
          message.reasoning_summary = tempDiv.textContent?.trim() || null;
        } else {
          message.reasoning_summary = thinkingEl.textContent?.trim() || null;
        }
      }
    }
    message.citations = extractCitations(el);
  }
  return message;
}

function extractClaudeMessagesGeneric() {
  const messages = [];
  const mainEl = document.querySelector('[role="main"]');
  if (!mainEl) return messages;
  const allBlocks = mainEl.querySelectorAll('p, div[class*="prose"], [class*="message"], [class*="response"]');
  let lastRole = null;
  allBlocks.forEach((el, index) => {
    const text = el.textContent?.trim() || '';
    if (text.length < 10) return;
    const hasFeedback = !!el.closest('article, div')?.querySelector('button[aria-label*="feedback"]');
    let role = hasFeedback ? 'assistant' : (lastRole === 'assistant' ? 'user' : 'user');
    if (role === lastRole) role = role === 'user' ? 'assistant' : 'user';
    messages.push({ id: `msg-${index}`, role, contentText: text, contentHtml: el.innerHTML, contentMarkdown: htmlToMarkdownSimple(el.innerHTML) });
    lastRole = role;
  });
  return messages;
}


// 通用 DOM 提取（兜底方案）
async function extractDataFromDOM() {
  console.log('[AI Export] Using DOM fallback extraction...');

  const messages = [];

  // 尝试查找所有可能是消息容器的元素
  const containers = document.querySelectorAll('[class*="message"], [class*="conversation"], [class*="chat"], article, section');

  containers.forEach((container, index) => {
    // 跳过嵌套的消息
    if (container.parentElement?.closest('[class*="message"]')) {
      return;
    }

    try {
      const text = container.textContent?.trim();
      if (!text || text.length < 10) return;

      // 判断角色
      const isUser = container.classList.contains('user') ||
                     container.classList.contains('user-message') ||
                     container.querySelector('[class*="user"]') !== null;

      const message = {
        id: `msg-${index}`,
        role: isUser ? 'user' : 'assistant',
        contentText: text,
        contentHtml: container.innerHTML,
        contentMarkdown: htmlToMarkdownSimple(container.innerHTML),
      };

      messages.push(message);
    } catch (err) {
      console.error('[AI Export] Failed to extract from container:', err);
    }
  });

  return { messages };
}

// 辅助函数：提取时间戳
function extractTimestamp(element) {
  const timeEl = element.querySelector('time');
  if (timeEl) {
    return timeEl.getAttribute('datetime') || timeEl.textContent;
  }

  // 尝试从属性中提取
  const datetime = element.getAttribute('data-timestamp') ||
                   element.getAttribute('data-created-at');
  if (datetime) return datetime;

  return null;
}

// 辅助函数：提取模型信息
function extractModel(element) {
  const modelEl = element.querySelector('[class*="model"], [data-model]');
  return modelEl?.getAttribute('data-model') || modelEl?.textContent;
}

// 辅助函数：提取引用
function extractCitations(element) {
  const citations = [];
  const citationElements = element.querySelectorAll('[class*="citation"], [class*="reference"], a[href^="http"]');

  citationElements.forEach((cite, index) => {
    const url = cite.getAttribute('href');
    if (url && url.startsWith('http')) {
      citations.push({
        index: index + 1,
        url: url,
        title: cite.getAttribute('title') || cite.textContent?.slice(0, 100),
      });
    }
  });

  return citations;
}

// 辅助函数：从页面提取标题
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
    const el = document.querySelector(selector);
    const text = normalizeInlineText(el?.textContent || '');
    if (text && text.toLowerCase() !== 'chatgpt') {
      return text;
    }
  }

  const cleanedDocumentTitle = cleanConversationTitle(document.title);
  if (cleanedDocumentTitle) {
    return cleanedDocumentTitle;
  }

  // 最后才兜底到页面标题元素，避免拿到正文里的 h1
  const titleSelectors = [
    '[data-conversation-title]',
    'header h1',
    '[class*="title"]',
    'title',
  ];

  for (const selector of titleSelectors) {
    const el = document.querySelector(selector);
    if (el) {
      const text = cleanConversationTitle(el.textContent?.trim() || '');
      if (text) return text;
    }
  }

  return '未命名会话';
}

// 辅助函数：简单的 HTML 转 Markdown
function htmlToMarkdownSimple(html) {
  if (!html) return '';

  const temp = document.createElement('div');
  temp.innerHTML = html;

  // 清理明显的 UI 杂质和隐藏噪音，避免正文被重复拼接。
  temp.querySelectorAll('button, svg, style, script, noscript, .sr-only, .screen-reader-only, [aria-hidden="true"]').forEach(el => {
    el.remove();
  });

  const markdown = serializeBlockChildren(temp).trim();
  return normalizeMarkdown(markdown);
}

function serializeBlockChildren(root, indent = 0) {
  let result = '';
  root.childNodes.forEach(node => {
    result += serializeNode(node, indent, false);
  });
  return result;
}

function serializeInlineChildren(root, indent = 0) {
  let result = '';
  root.childNodes.forEach(node => {
    result += serializeNode(node, indent, true);
  });
  return normalizeInlineText(result);
}

function serializeNode(node, indent = 0, inlineContext = false) {
  if (node.nodeType === Node.TEXT_NODE) {
    return inlineContext ? normalizeInlineText(node.textContent || '') : (node.textContent || '');
  }

  if (node.nodeType !== Node.ELEMENT_NODE) {
    return '';
  }

  const el = node;
  const tag = el.tagName.toLowerCase();

  const mathMarkdown = extractMathMarkdown(el, inlineContext);
  if (mathMarkdown !== null) {
    return mathMarkdown;
  }

  switch (tag) {
    case 'br':
      return inlineContext ? ' ' : '  \n';

    case 'pre': {
      const codeEl = el.querySelector('code');
      const langClass = codeEl?.className || '';
      const match = langClass.match(/language-([\w-]+)/);
      const lang = match ? match[1] : '';
      const codeText = serializePreformattedText(codeEl || el).replace(/\r/g, '').trimEnd();
      return `\n\`\`\`${lang}\n${codeText}\n\`\`\`\n\n`;
    }

    case 'code':
      return `\`${normalizeInlineText(getVisibleText(el))}\``;

    case 'strong':
    case 'b':
      return `**${serializeInlineChildren(el, indent)}**`;

    case 'em':
    case 'i':
      return `*${serializeInlineChildren(el, indent)}*`;

    case 'a': {
      const href = el.getAttribute('href') || '';
      const text = normalizeInlineText(getVisibleText(el)) || href;
      if (!href || href.startsWith('#') || href.startsWith('javascript:')) {
        return text;
      }
      return `[${text}](${href})`;
    }

    case 'h1':
    case 'h2':
    case 'h3':
    case 'h4':
    case 'h5':
    case 'h6': {
      const level = Number(tag[1]);
      const title = serializeInlineChildren(el, indent);
      return `\n${'#'.repeat(level)} ${title}\n\n`;
    }

    case 'p': {
      const text = serializeInlineChildren(el, indent);
      return text ? `${text}\n\n` : '';
    }

    case 'blockquote': {
      const text = normalizeMarkdown(serializeBlockChildren(el, indent).trim());
      if (!text) return '';
      const quoted = text.split('\n').map(line => line ? `> ${line}` : '>').join('\n');
      return `${quoted}\n\n`;
    }

    case 'ul':
      return serializeList(el, false, indent);

    case 'ol':
      return serializeList(el, true, indent);

    case 'table':
      return serializeTable(el);

    case 'hr':
      return `\n---\n\n`;

    case 'div':
    case 'section':
    case 'article':
    case 'main': {
      if (hasBlockChildren(el)) {
        return serializeBlockChildren(el, indent);
      }
      const text = serializeInlineChildren(el, indent);
      return text ? `${text}\n\n` : '';
    }

    case 'span':
      return serializeInlineChildren(el, indent);

    default: {
      if (hasBlockChildren(el)) {
        return serializeBlockChildren(el, indent);
      }
      return serializeInlineChildren(el, indent);
    }
  }
}

function serializeList(listEl, ordered, indent = 0) {
  const items = Array.from(listEl.children).filter(child => child.tagName?.toLowerCase() === 'li');
  if (!items.length) return '';

  let result = '';
  items.forEach((li, index) => {
    result += serializeListItem(li, ordered ? `${index + 1}.` : '-', indent);
  });
  return `${result}\n`;
}

function serializeListItem(li, marker, indent = 0) {
  let inlineParts = '';
  let nestedParts = '';

  li.childNodes.forEach(child => {
    if (child.nodeType === Node.ELEMENT_NODE) {
      const tag = child.tagName.toLowerCase();
      if (tag === 'ul' || tag === 'ol') {
        nestedParts += serializeList(child, tag === 'ol', indent + 1);
        return;
      }
      if (tag === 'p') {
        const text = serializeInlineChildren(child, indent).trim();
        if (text) inlineParts += (inlineParts ? ' ' : '') + text;
        return;
      }
      if (tag === 'pre') {
        nestedParts += serializeNode(child, indent + 1, false);
        return;
      }
    }

    const fragment = serializeNode(child, indent + 1, true).trim();
    if (fragment) {
      inlineParts += (inlineParts ? ' ' : '') + fragment;
    }
  });

  const indentStr = '  '.repeat(indent);
  let result = '';

  if (inlineParts) {
    result += `${indentStr}${marker} ${inlineParts}\n`;
  }

  if (nestedParts) {
    result += nestedParts;
  }

  return result;
}

function serializeTable(tableEl) {
  const rows = Array.from(tableEl.querySelectorAll('tr'));
  if (!rows.length) return '';

  let markdown = '\n';
  rows.forEach((tr, rowIndex) => {
    const cells = Array.from(tr.querySelectorAll('th, td')).map(cell => {
      return normalizeInlineText(getVisibleText(cell)).replace(/\|/g, '\\|') || ' ';
    });
    markdown += `| ${cells.join(' | ')} |\n`;
    if (rowIndex === 0) {
      markdown += `| ${cells.map(() => '---').join(' | ')} |\n`;
    }
  });

  return `${markdown}\n`;
}

function hasBlockChildren(el) {
  return Array.from(el.children).some(child => {
    return /^(div|section|article|main|p|pre|blockquote|ul|ol|table|h[1-6]|hr)$/i.test(child.tagName);
  });
}

function extractMathMarkdown(el, inlineContext = false) {
  const tag = el.tagName.toLowerCase();
  const className = typeof el.className === 'string' ? el.className : '';

  if (tag === 'annotation' || tag === 'annotation-xml' || tag === 'semantics') {
    return '';
  }

  if (/(katex-html|mjx-assistive-mml|MathJax_Preview)/i.test(className)) {
    return '';
  }

  const isMathContainer =
    tag === 'math' ||
    tag === 'mjx-container' ||
    /(?:^|\s)(katex|katex-display|katex-mathml|math-display|math-inline)(?:\s|$)/i.test(className) ||
    /(mjx|mathjax)/i.test(className) ||
    el.classList.contains('katex') ||
    el.classList.contains('katex-display') ||
    el.classList.contains('math') ||
    el.classList.contains('math-display') ||
    el.hasAttribute('data-tex');

  if (!isMathContainer) {
    return null;
  }

  const latex =
    el.getAttribute('data-tex') ||
    el.getAttribute('data-latex') ||
    el.getAttribute('aria-label') ||
    el.querySelector('annotation[encoding="application/x-tex"]')?.textContent ||
    el.querySelector('annotation[encoding="application/x-latex"]')?.textContent ||
    el.querySelector('annotation[encoding*="tex" i]')?.textContent ||
    el.querySelector('annotation[encoding*="latex" i]')?.textContent ||
    el.querySelector('script[type^="math/tex"]')?.textContent ||
    el.querySelector('annotation')?.textContent ||
    '';

  const cleanLatex = latex.replace(/\s+/g, ' ').trim();
  if (!cleanLatex) {
    const fallbackText = normalizeInlineText(getVisibleText(el));
    if (!fallbackText) return '';
    return inlineContext ? `$${fallbackText}$` : `\n$$\n${fallbackText}\n$$\n\n`;
  }

  const isBlockMath =
    !inlineContext ||
    tag === 'mjx-container' ||
    el.classList.contains('katex-display') ||
    el.classList.contains('math-display') ||
    /display/i.test(className) ||
    getVisibleText(el).includes('\n');

  if (isBlockMath) {
    return `\n$$\n${cleanLatex}\n$$\n\n`;
  }

  return `$${cleanLatex}$`;
}

function serializePreformattedText(root) {
  const parts = [];

  function walk(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      parts.push(node.textContent || '');
      return;
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return;
    }

    const el = node;
    const tag = el.tagName.toLowerCase();

    if (tag === 'br') {
      parts.push('\n');
      return;
    }

    const children = Array.from(el.childNodes);
    children.forEach((child, index) => {
      walk(child);

      if (child.nodeType === Node.ELEMENT_NODE) {
        const childEl = child;
        const childTag = childEl.tagName.toLowerCase();
        const shouldBreakLine =
          /^(div|p|li|tr)$/.test(childTag) ||
          /(line|code-line)/i.test(childEl.className || '') ||
          childEl.getAttribute('data-line') !== null;

        if (shouldBreakLine && index < children.length - 1) {
          if (!parts[parts.length - 1]?.endsWith('\n')) {
            parts.push('\n');
          }
        }
      }
    });
  }

  walk(root);

  return parts.join('')
    .replace(/\u00a0/g, ' ')
    .replace(/\n{3,}/g, '\n\n');
}

function getVisibleText(el) {
  const text = typeof el.innerText === 'string' ? el.innerText : (el.textContent || '');
  return text.replace(/\u00a0/g, ' ');
}

function normalizeInlineText(text) {
  return text
    .replace(/\s+/g, ' ')
    .replace(/\s+([,.;:!?])/g, '$1')
    .trim();
}

function normalizeMarkdown(text) {
  return text
    .replace(/\r/g, '')
    .replace(/[ \t]+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
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

// 辅助函数：等待元素出现
function waitForElement(selector, timeout = 5000) {
  return new Promise((resolve, reject) => {
    const element = document.querySelector(selector);
    if (element) {
      resolve(element);
      return;
    }

    const observer = new MutationObserver(() => {
      const element = document.querySelector(selector);
      if (element) {
        observer.disconnect();
        resolve(element);
      }
    });

    observer.observe(document.body, { childList: true, subtree: true });

    setTimeout(() => {
      observer.disconnect();
      reject(new Error(`Timeout waiting for ${selector}`));
    }, timeout);
  });
}

console.log('[AI Export] Content script initialized, platform:', getPageInfo().platform);

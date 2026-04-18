// background.js - Service Worker for AI Session Export Tool

var OFFSCREEN_REASON = 'file-download';

// ========== HTML to Markdown ==========
function htmlToMarkdown(html) {
  if (!html) return '';
  var md = html;
  md = md.replace(/<pre\b[^>]*>\s*<code\b[^>]*class="[^"]*language-([\w-]+)[^"]*"[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, function(_, lang, code) {
    return '\n```' + lang + '\n' + decodeHtml(code).trim() + '\n```\n';
  });
  md = md.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, function(_, code) {
    return '\n```\n' + decodeHtml(code).trim() + '\n```\n';
  });
  md = md.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, function(_, code) {
    return '`' + decodeHtml(code).trim() + '`';
  });
  md = md.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, function(_, __, text) {
    return '**' + decodeHtml(text).trim() + '**';
  });
  md = md.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, function(_, __, text) {
    return '*' + decodeHtml(text).trim() + '*';
  });
  md = md.replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, function(_, href, text) {
    var cleanText = decodeHtml(stripTags(text)).trim() || href;
    if (href.indexOf('#') === 0 || href.indexOf('javascript:') === 0) return cleanText;
    return '[' + cleanText + '](' + href + ')';
  });
  md = md.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, function(_, item) {
    return '- ' + decodeHtml(stripTags(item)).trim() + '\n';
  });
  md = md.replace(/<(p|div|section|article|h[1-6]|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi, function(_, tag, text) {
    var clean = decodeHtml(stripTags(text)).trim();
    if (!clean) return '';
    if (tag === 'blockquote') return '\n' + clean.split(/\r?\n/).map(function(l) { return '> ' + l; }).join('\n') + '\n\n';
    return clean + '\n\n';
  });
  md = md.replace(/<br\s*\/?>/gi, '  \n')
         .replace(/<hr\s*\/?>/gi, '\n---\n')
         .replace(/<\/?(ul|ol|table|tbody|thead|tr|td|th)[^>]*>/gi, '\n')
         .replace(/<[^>]+>/g, '')
         .replace(/\r/g, '')
         .replace(/\n{4,}/g, '\n\n\n')
         .replace(/[ \t]+\n/g, '\n')
         .trim();
  return decodeHtml(md);
}

function stripTags(html) { return html.replace(/<[^>]+>/g, ''); }

function decodeHtml(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

// ========== Offscreen Document Management ==========
async function ensureOffscreen() {
  var existing = await chrome.offscreen.getDocuments({});
  if (existing.length > 0) return;
  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['DOM_PARSER'],
    justification: OFFSCREEN_REASON
  });
}

async function offscreenDownload(filename, content, mimeType) {
  await ensureOffscreen();
  var result = await chrome.runtime.sendMessage({
    type: 'TRIGGER_DOWNLOAD',
    filename: filename,
    content: content,
    mimeType: mimeType
  });
  if (!result || !result.success) {
    throw new Error(result && result.error ? result.error : 'Offscreen download failed');
  }
  // Close offscreen document after download
  setTimeout(function() {
    chrome.offscreen.getDocuments({}).then(function(docs) {
      if (docs.length > 0) chrome.offscreen.closeDocument(docs[0].id);
    });
  }, 2000);
  return { success: true, filename: filename };
}

// ========== Export Functions ==========
function getDefaultSettings() {
  return {
    includeTimestamp: true,
    includeModelInfo: true,
    includeReferences: true,
    includeReasoningSummary: true,
    format: 'markdown',
    filenameTemplate: '{title}_{timestamp}.md'
  };
}

function convertToMarkdown(conversation, settings) {
  var md = '';
  if (settings.includeModelInfo) {
    md += '---\n';
    md += '标题：' + (conversation.title || '未命名会话') + '\n';
    md += '平台：' + (conversation.platform || 'AI 会话') + '\n';
    if (conversation.model) md += '模型：' + conversation.model + '\n';
    if (conversation.createTime) md += '创建时间：' + conversation.createTime + '\n';
    md += '导出时间：' + new Date().toISOString() + '\n';
    md += '---\n\n';
  }

  if (conversation.messages) {
    conversation.messages.forEach(function(msg) {
      var roleLabel = msg.role === 'user' ? '用户' : 'AI';
      md += '## ' + roleLabel;
      if (settings.includeTimestamp && msg.createdAt) {
        md += ' *(' + msg.createdAt + ')*';
      }
      md += '\n\n';

      if (settings.includeReasoningSummary && msg.reasoning_summary) {
        md += '<details>\n<summary>思考过程</summary>\n\n';
        md += msg.reasoning_summary + '\n\n';
        md += '</details>\n\n';
      }

      if (msg.contentMarkdown) {
        md += msg.contentMarkdown;
      } else if (msg.contentHtml) {
        md += htmlToMarkdown(msg.contentHtml);
      } else if (msg.contentText) {
        md += msg.contentText;
      }
      md += '\n\n';

      if (settings.includeReferences && msg.citations && msg.citations.length > 0) {
        md += '### 引用来源\n\n';
        msg.citations.forEach(function(cite, idx) {
          md += (idx + 1) + '. [' + (cite.title || '无标题') + '](' + cite.url + ')\n';
        });
        md += '\n';
      }
      md += '---\n\n';
    });
  }
  return md;
}

function generateFilename(conversation, settings) {
  var timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  var title = (conversation.title || extractTitleFromMessages(conversation.messages))
    .replace(/[\\/:*?"<>|]/g, '_').slice(0, 50);
  return settings.filenameTemplate
    .replace('{title}', title)
    .replace('{timestamp}', timestamp)
    .replace('{platform}', conversation.platform || 'ai');
}

function extractTitleFromMessages(messages) {
  if (!messages || messages.length === 0) return '未命名会话';
  var firstUserMsg = messages.find(function(m) { return m.role === 'user'; });
  if (!firstUserMsg) return '未命名会话';
  var text = firstUserMsg.contentText || firstUserMsg.contentMarkdown || '';
  var title = text.split('\n')[0].slice(0, 50).trim();
  return title || '未命名会话';
}

// ========== Message Listeners ==========
chrome.action.onClicked.addListener(function(tab) {
  console.log('[AI Export] Extension icon clicked', tab.url);
});

chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
  console.log('[AI Export] Received message:', message.type);

  switch (message.type) {
    case 'EXPORT_REQUEST':
      handleExportRequest(message.data, sendResponse);
      return true;
    case 'GET_EXPORT_SETTINGS':
      chrome.storage.local.get(['exportSettings'], function(result) {
        sendResponse(result.exportSettings || getDefaultSettings());
      });
      return true;
    case 'SAVE_EXPORT_SETTINGS':
      chrome.storage.local.set({ exportSettings: message.settings }, function() {
        sendResponse({ success: true });
      });
      return true;
    default:
      sendResponse({ error: 'Unknown message type' });
  }
});

async function handleExportRequest(data, sendResponse) {
  try {
    var conversation = data.conversation;
    var settings = data.settings;
    var markdown = convertToMarkdown(conversation, settings);
    var filename = generateFilename(conversation, settings);
    var result = await offscreenDownload(filename, markdown, 'text/markdown;charset=utf-8');
    sendResponse({ success: true, filename: result.filename });
  } catch (error) {
    console.error('[AI Export] Export failed:', error);
    sendResponse({ success: false, error: error.message });
  }
}

chrome.storage.local.get(['exportSettings'], function(result) {
  if (!result.exportSettings) {
    chrome.storage.local.set({ exportSettings: getDefaultSettings() });
  }
});

console.log('[AI Export] Background service worker initialized');

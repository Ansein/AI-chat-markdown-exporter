// background.js - Service Worker for AI Session Export Tool

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
    md += '\u6807\u9898\uff1a' + (conversation.title || '\u672a\u547d\u540d\u4f1a\u8bdd') + '\n';
    md += '\u5e73\u53f0\uff1a' + (conversation.platform || 'AI \u4f1a\u8bdd') + '\n';
    if (conversation.model) md += '\u6a21\u578b\uff1a' + conversation.model + '\n';
    if (conversation.createTime) md += '\u521b\u5efa\u65f6\u95f4\uff1a' + conversation.createTime + '\n';
    md += '\u5bfc\u51fa\u65f6\u95f4\uff1a' + new Date().toISOString() + '\n';
    md += '---\n\n';
  }

  if (conversation.messages) {
    conversation.messages.forEach(function(msg) {
      var roleLabel = msg.role === 'user' ? '\u7528\u6237' : 'AI';
      md += '## ' + roleLabel;
      if (settings.includeTimestamp && msg.createdAt) {
        md += ' *(' + msg.createdAt + ')*';
      }
      md += '\n\n';

      if (settings.includeReasoningSummary && msg.reasoning_summary) {
        md += '<details>\n<summary>\u601d\u8003\u8fc7\u7a0b</summary>\n\n';
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
        md += '### \u5f15\u7528\u6765\u6e90\n\n';
        msg.citations.forEach(function(cite, idx) {
          md += (idx + 1) + '. [' + (cite.title || '\u65e0\u6807\u9898') + '](' + cite.url + ')\n';
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
    .replace(/[\/:*?"<>|]/g, '_').slice(0, 50);
  return settings.filenameTemplate
    .replace('{title}', title)
    .replace('{timestamp}', timestamp)
    .replace('{platform}', conversation.platform || 'ai');
}

function extractTitleFromMessages(messages) {
  if (!messages || messages.length === 0) return '\u672a\u547d\u540d\u4f1a\u8bdd';
  var firstUserMsg = messages.find(function(m) { return m.role === 'user'; });
  if (!firstUserMsg) return '\u672a\u547d\u540d\u4f1a\u8bdd';
  var text = firstUserMsg.contentText || firstUserMsg.contentMarkdown || '';
  var title = text.split('\n')[0].slice(0, 50).trim();
  return title || '\u672a\u547d\u540d\u4f1a\u8bdd';
}

// ========== Message Listeners ==========
chrome.action.onClicked.addListener(function(tab) {
  console.log('[AI Export] Extension icon clicked', tab.url);
});

chrome.runtime.onMessage.addListener(function(message, sender, sendResponse) {
  console.log('[AI Export] Received message:', message.type);

  switch (message.type) {
    case 'CONVERT_TO_MARKDOWN':
      try {
        var conversation = message.data.conversation;
        var settings = message.data.settings;
        var markdown = convertToMarkdown(conversation, settings);
        var filename = generateFilename(conversation, settings);
        sendResponse({ success: true, markdown: markdown, filename: filename });
      } catch (error) {
        console.error('[AI Export] Conversion failed:', error);
        sendResponse({ success: false, error: error.message });
      }
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

chrome.storage.local.get(['exportSettings'], function(result) {
  if (!result.exportSettings) {
    chrome.storage.local.set({ exportSettings: getDefaultSettings() });
  }
});

console.log('[AI Export] Background service worker initialized');

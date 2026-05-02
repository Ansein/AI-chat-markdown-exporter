// background.js - Service Worker for AI Session Export Tool (v2.0)

const CacheManager = {
  STORAGE_KEY: 'ai_export_cache',
  MAX_CACHE_SIZE: 50,

  async getAll() {
    try {
      const result = await chrome.storage.local.get([this.STORAGE_KEY]);
      return result[this.STORAGE_KEY] || [];
    } catch (error) {
      console.error('[AI Export] CacheManager.getAll failed:', error);
      return [];
    }
  },

  async save(conversation) {
    try {
      const conversations = await this.getAll();

      const existingIndex = conversations.findIndex(c => c.id === conversation.id);
      if (existingIndex >= 0) {
        conversations[existingIndex] = conversation;
      } else {
        conversations.unshift(conversation);
      }

      if (conversations.length > this.MAX_CACHE_SIZE) {
        conversations.splice(this.MAX_CACHE_SIZE);
      }

      await chrome.storage.local.set({ [this.STORAGE_KEY]: conversations });
      return conversation;
    } catch (error) {
      console.error('[AI Export] CacheManager.save failed:', error);
      throw error;
    }
  },

  async getById(id) {
    const conversations = await this.getAll();
    return conversations.find(c => c.id === id);
  },

  async delete(id) {
    const conversations = await this.getAll();
    const filtered = conversations.filter(c => c.id !== id);
    await chrome.storage.local.set({ [this.STORAGE_KEY]: filtered });
    return true;
  },

  async clear() {
    await chrome.storage.local.remove([this.STORAGE_KEY]);
    return true;
  },

  async search(options = {}) {
    const { query = '', platform = null, startDate = null, endDate = null, limit = 100, offset = 0 } = options;
    let conversations = await this.getAll();

    if (query && query.trim()) {
      const lowerQuery = query.toLowerCase();
      conversations = conversations.filter(c => {
        const titleMatch = c.title?.toLowerCase().includes(lowerQuery);
        const messagesMatch = c.messages?.some(m =>
          (m.contentText?.toLowerCase().includes(lowerQuery)) ||
          (m.contentMarkdown?.toLowerCase().includes(lowerQuery))
        );
        return titleMatch || messagesMatch;
      });
    }

    if (platform) {
      conversations = conversations.filter(c => c.platform === platform);
    }

    if (startDate || endDate) {
      conversations = conversations.filter(c => {
        const exportedAt = c.exportedAt ? new Date(c.exportedAt) : null;
        if (!exportedAt) return true;

        if (startDate && exportedAt < new Date(startDate)) return false;
        if (endDate && exportedAt > new Date(endDate)) return false;
        return true;
      });
    }

    return {
      conversations: conversations.slice(offset, offset + limit),
      total: conversations.length,
      offset,
      limit,
    };
  },

  async exportAll() {
    const conversations = await this.getAll();
    return {
      version: '2.0',
      exportedAt: new Date().toISOString(),
      count: conversations.length,
      conversations,
    };
  },

  async importAll(data) {
    if (!data || !data.conversations || !Array.isArray(data.conversations)) {
      throw new Error('Invalid import data format');
    }

    const existing = await this.getAll();
    const existingIds = new Set(existing.map(c => c.id));

    const newConversations = data.conversations.filter(c => !existingIds.has(c.id));
    const merged = [...newConversations, ...existing];

    if (merged.length > this.MAX_CACHE_SIZE) {
      merged.splice(this.MAX_CACHE_SIZE);
    }

    await chrome.storage.local.set({ [this.STORAGE_KEY]: merged });
    return {
      imported: newConversations.length,
      existing: data.conversations.length - newConversations.length,
    };
  },
};

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
    md += '\u5e73\u53f0\uff1a' + (conversation.platformName || conversation.platform || 'AI \u4f1a\u8bdd') + '\n';
    if (conversation.model) md += '\u6a21\u578b\uff1a' + conversation.model + '\n';
    if (conversation.createTime) md += '\u521b\u5efa\u65f6\u95f4\uff1a' + conversation.createTime + '\n';
    if (conversation.exportedAt) md += '\u5bfc\u51fa\u65f6\u95f4\uff1a' + conversation.exportedAt + '\n';
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

function createBatchExportFile(conversations, settings) {
  var files = [];
  var indexContent = '# 批量导出会话列表\n\n';
  indexContent += `导出时间: ${new Date().toISOString()}\n`;
  indexContent += `共 ${conversations.length} 个会话\n\n`;
  indexContent += '---\n\n';

  conversations.forEach((conv, index) => {
    const filename = generateFilename(conv, settings);
    const markdown = convertToMarkdown(conv, settings);

    files.push({
      filename,
      content: markdown,
      platform: conv.platform,
      title: conv.title,
    });

    indexContent += `## ${index + 1}. ${conv.title || '未命名会话'}\n`;
    indexContent += `- 平台: ${conv.platformName || conv.platform}\n`;
    indexContent += `- 消息数: ${conv.messages?.length || 0}\n`;
    indexContent += `- 文件名: ${filename}\n\n`;
  });

  return {
    indexContent,
    files,
  };
}

function createTextFileBundle(files, indexContent) {
  let bundle = '';

  bundle += '='.repeat(60) + '\n';
  bundle += '           AI 会话批量导出文件\n';
  bundle += '='.repeat(60) + '\n\n';

  bundle += '【目录索引】\n';
  bundle += '='.repeat(60) + '\n\n';
  bundle += indexContent;
  bundle += '\n' + '='.repeat(60) + '\n\n';

  files.forEach((file, index) => {
    bundle += `\n${'='.repeat(60)}\n`;
    bundle += `文件 ${index + 1}: ${file.filename}\n`;
    bundle += `标题: ${file.title}\n`;
    bundle += `平台: ${file.platform}\n`;
    bundle += '='.repeat(60) + '\n\n';
    bundle += file.content;
    bundle += '\n\n';
  });

  return bundle;
}

async function downloadFile(filename, content, mimeType = 'text/markdown;charset=utf-8') {
  try {
    const blob = new Blob([content], { type: mimeType });
    const url = URL.createObjectURL(blob);

    await chrome.downloads.download({
      url: url,
      filename: filename,
      saveAs: true,
    });

    setTimeout(() => URL.revokeObjectURL(url), 5000);
    return { success: true };
  } catch (error) {
    console.error('[AI Export] downloadFile failed:', error);
    throw error;
  }
}

function normalizeConversationId(conversation) {
  if (conversation.id) return conversation;

  let id = null;

  if (conversation.metadata?.conversationId) {
    id = conversation.metadata.conversationId;
  } else if (conversation.conversation_id) {
    id = conversation.conversation_id;
  } else if (conversation.messages && conversation.messages.length > 0) {
    const firstMsg = conversation.messages[0];
    if (firstMsg.id) {
      id = firstMsg.id + '-conv';
    }
  }

  if (!id) {
    const url = conversation.url || '';
    const pathParts = url.split('/').filter(p => p);
    for (const part of pathParts.reverse()) {
      if (part.length > 5 && !part.includes('.')) {
        id = part;
        break;
      }
    }
  }

  if (!id) {
    const title = conversation.title || '';
    const timestamp = conversation.exportedAt || new Date().toISOString();
    id = title.slice(0, 20).replace(/[^\w]/g, '') + '-' + timestamp.slice(0, 10);
  }

  if (!id) {
    id = 'conv-' + Date.now() + '-' + Math.random().toString(36).slice(2);
  }

  return { ...conversation, id };
}

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

    case 'SAVE_TO_CACHE':
      (async () => {
        try {
          let conversation = normalizeConversationId(message.conversation);
          const saved = await CacheManager.save(conversation);
          sendResponse({ success: true, conversation: saved });
        } catch (error) {
          sendResponse({ success: false, error: error.message });
        }
      })();
      return true;

    case 'GET_CACHE_LIST':
      (async () => {
        try {
          const options = message.options || {};
          const result = await CacheManager.search(options);
          sendResponse({ success: true, ...result });
        } catch (error) {
          sendResponse({ success: false, error: error.message });
        }
      })();
      return true;

    case 'DELETE_FROM_CACHE':
      (async () => {
        try {
          await CacheManager.delete(message.id);
          sendResponse({ success: true });
        } catch (error) {
          sendResponse({ success: false, error: error.message });
        }
      })();
      return true;

    case 'CLEAR_CACHE':
      (async () => {
        try {
          await CacheManager.clear();
          sendResponse({ success: true });
        } catch (error) {
          sendResponse({ success: false, error: error.message });
        }
      })();
      return true;

    case 'EXPORT_ALL_CACHE':
      (async () => {
        try {
          const data = await CacheManager.exportAll();
          const jsonContent = JSON.stringify(data, null, 2);
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
          const filename = `ai-export-backup-${timestamp}.json`;

          await downloadFile(filename, jsonContent, 'application/json');
          sendResponse({ success: true, filename });
        } catch (error) {
          sendResponse({ success: false, error: error.message });
        }
      })();
      return true;

    case 'IMPORT_CACHE_DATA':
      (async () => {
        try {
          const result = await CacheManager.importAll(message.data);
          sendResponse({ success: true, ...result });
        } catch (error) {
          sendResponse({ success: false, error: error.message });
        }
      })();
      return true;

    case 'BATCH_EXPORT_CONVERSATIONS':
      (async () => {
        try {
          const conversations = message.conversations || [];
          const settings = message.settings || getDefaultSettings();

          if (conversations.length === 0) {
            sendResponse({ success: false, error: 'No conversations to export' });
            return;
          }

          if (conversations.length === 1) {
            const conv = conversations[0];
            const markdown = convertToMarkdown(conv, settings);
            const filename = generateFilename(conv, settings);
            await downloadFile(filename, markdown);
            sendResponse({ success: true, count: 1, filenames: [filename] });
            return;
          }

          const bundle = createBatchExportFile(conversations, settings);
          const content = createTextFileBundle(bundle.files, bundle.indexContent);
          const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
          const filename = `ai-chat-export-bundle-${timestamp}.md`;

          await downloadFile(filename, content);
          sendResponse({
            success: true,
            count: conversations.length,
            filename,
            filenames: bundle.files.map(f => f.filename),
          });
        } catch (error) {
          console.error('[AI Export] Batch export failed:', error);
          sendResponse({ success: false, error: error.message });
        }
      })();
      return true;

    case 'DOWNLOAD_FILE':
      (async () => {
        try {
          const result = await downloadFile(message.filename, message.content, message.mimeType);
          sendResponse({ success: true, ...result });
        } catch (error) {
          sendResponse({ success: false, error: error.message });
        }
      })();
      return true;

    case 'PAGE_DATA_CAPTURED':
      console.log('[AI Export] Page data captured:', message.data?.type);
      sendResponse({ received: true });
      return true;

    default:
      sendResponse({ error: 'Unknown message type' });
  }
});

chrome.action.onClicked.addListener(function(tab) {
  console.log('[AI Export] Extension icon clicked', tab.url);
});

chrome.storage.local.get(['exportSettings'], function(result) {
  if (!result.exportSettings) {
    chrome.storage.local.set({ exportSettings: getDefaultSettings() });
  }
});

console.log('[AI Export] Background service worker initialized (v2.0)');

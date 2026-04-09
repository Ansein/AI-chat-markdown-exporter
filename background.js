// background.js - Service Worker for AI Session Export Tool
// 处理扩展后台逻辑、消息转发、导出任务

// ========== HTML 转 Markdown 工具函数 ==========
function htmlToMarkdown(html) {
  if (!html) return '';

  // MV3 service worker 中没有 document，这里使用一个保底的无 DOM 转换。
  // 详细格式化优先依赖 content script 预先提供的 contentMarkdown。
  let markdown = html;

  markdown = markdown.replace(/<pre\b[^>]*>\s*<code\b[^>]*class="[^"]*language-([\w-]+)[^"]*"[^>]*>([\s\S]*?)<\/code>\s*<\/pre>/gi, (_, lang, code) => {
    return `\n\`\`\`${lang}\n${decodeHtmlEntities(code).trim()}\n\`\`\`\n`;
  });
  markdown = markdown.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre>/gi, (_, code) => {
    return `\n\`\`\`\n${decodeHtmlEntities(code).trim()}\n\`\`\`\n`;
  });
  markdown = markdown.replace(/<code\b[^>]*>([\s\S]*?)<\/code>/gi, (_, code) => {
    return `\`${decodeHtmlEntities(code).trim()}\``;
  });
  markdown = markdown.replace(/<(strong|b)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, text) => {
    return `**${decodeHtmlEntities(text).trim()}**`;
  });
  markdown = markdown.replace(/<(em|i)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, _tag, text) => {
    return `*${decodeHtmlEntities(text).trim()}*`;
  });
  markdown = markdown.replace(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, (_, href, text) => {
    const cleanText = decodeHtmlEntities(stripTags(text)).trim() || href;
    return href.startsWith('#') || href.startsWith('javascript:')
      ? cleanText
      : `[${cleanText}](${href})`;
  });
  markdown = markdown.replace(/<li\b[^>]*>([\s\S]*?)<\/li>/gi, (_, item) => `- ${decodeHtmlEntities(stripTags(item)).trim()}\n`);
  markdown = markdown.replace(/<(p|div|section|article|h[1-6]|blockquote)\b[^>]*>([\s\S]*?)<\/\1>/gi, (_, tag, text) => {
    const cleanText = decodeHtmlEntities(stripTags(text)).trim();
    if (!cleanText) return '';
    if (tag === 'blockquote') {
      return `\n${cleanText.split(/\r?\n/).map(line => `> ${line}`).join('\n')}\n\n`;
    }
    return `${cleanText}\n\n`;
  });
  markdown = markdown
    .replace(/<br\s*\/?>/gi, '  \n')
    .replace(/<hr\s*\/?>/gi, '\n---\n')
    .replace(/<\/?(ul|ol|table|tbody|thead|tr|td|th)[^>]*>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/\r/g, '')
    .replace(/\n{4,}/g, '\n\n\n')
    .replace(/[ \t]+\n/g, '\n')
    .trim();

  return decodeHtmlEntities(markdown);
}

function stripTags(html) {
  return html.replace(/<[^>]+>/g, '');
}

function decodeHtmlEntities(text) {
  return text
    .replace(/&nbsp;/gi, ' ')
    .replace(/&amp;/gi, '&')
    .replace(/&lt;/gi, '<')
    .replace(/&gt;/gi, '>')
    .replace(/&quot;/gi, '"')
    .replace(/&#39;/gi, "'");
}

// ========== 导出相关函数 ==========

// 默认设置
function getDefaultSettings() {
  return {
    includeTimestamp: true,
    includeModelInfo: true,
    includeReferences: true,
    includeReasoningSummary: true,
    format: 'markdown',
    filenameTemplate: '{title}_{timestamp}.md',
  };
}

// 转换为 Markdown
function convertToMarkdown(conversation, settings) {
  let md = '';

  // 头部元数据
  if (settings.includeModelInfo) {
    md += `---\n`;
    md += `标题：${conversation.title || '未命名会话'}\n`;
    md += `平台：${conversation.platform || 'AI 会话'}\n`;
    if (conversation.model) md += `模型：${conversation.model}\n`;
    if (conversation.createTime) md += `创建时间：${conversation.createTime}\n`;
    md += `导出时间：${new Date().toISOString()}\n`;
    md += `---\n\n`;
  }

  // 消息内容
  conversation.messages?.forEach(msg => {
    const roleLabel = msg.role === 'user' ? '👤 用户' : '🤖 AI';
    md += `## ${roleLabel}`;

    if (settings.includeTimestamp && msg.createdAt) {
      md += ` *(${msg.createdAt})*`;
    }
    md += `\n\n`;

    // 思考过程
    if (settings.includeReasoningSummary && msg.reasoning_summary) {
      md += `<details>\n<summary>💭 思考过程</summary>\n\n`;
      md += `${msg.reasoning_summary}\n\n`;
      md += `</details>\n\n`;
    }

    // 消息内容
    if (msg.contentMarkdown) {
      md += msg.contentMarkdown;
    } else if (msg.contentHtml) {
      md += htmlToMarkdown(msg.contentHtml);
    } else if (msg.contentText) {
      md += msg.contentText;
    }

    md += `\n\n`;

    // 引用
    if (settings.includeReferences && msg.citations?.length > 0) {
      md += `### 引用来源\n\n`;
      msg.citations.forEach((cite, idx) => {
        md += `${idx + 1}. [${cite.title || '无标题'}](${cite.url})\n`;
      });
      md += `\n`;
    }

    md += `---\n\n`;
  });

  return md;
}

// 生成文件名
function generateFilename(conversation, settings) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, -5);
  const title = (conversation.title || extractTitleFromMessages(conversation.messages))
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(0, 50);

  return settings.filenameTemplate
    .replace('{title}', title)
    .replace('{timestamp}', timestamp)
    .replace('{platform}', conversation.platform || 'ai');
}

// 从消息中提取标题
function extractTitleFromMessages(messages) {
  if (!messages?.length) return '未命名会话';
  const firstUserMsg = messages.find(m => m.role === 'user');
  if (!firstUserMsg) return '未命名会话';
  const text = firstUserMsg.contentText || firstUserMsg.contentMarkdown || '';
  const title = text.split('\n')[0].slice(0, 50).trim();
  return title || '未命名会话';
}

// 下载文件
async function downloadFile(filename, content, mimeType) {
  const encodedContent = encodeURIComponent(content);
  const dataUrl = `data:${mimeType};charset=utf-8,${encodedContent}`;

  return await new Promise((resolve, reject) => {
    chrome.downloads.download({
      filename,
      url: dataUrl,
      saveAs: false,
      conflictAction: 'uniquify',
    }, (downloadId) => {
      if (chrome.runtime.lastError) {
        console.error('[AI Export] Download failed:', chrome.runtime.lastError.message);
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (typeof downloadId !== 'number') {
        reject(new Error('下载未返回有效的 downloadId'));
        return;
      }

      console.log('[AI Export] Download started:', downloadId);

      setTimeout(() => {
        chrome.downloads.search({ id: downloadId }, (items) => {
          if (chrome.runtime.lastError) {
            console.warn('[AI Export] Failed to query download item:', chrome.runtime.lastError.message);
            resolve({ downloadId, filename, mimeType });
            return;
          }

          const item = items?.[0];
          resolve({
            downloadId,
            filename,
            mimeType,
            localPath: item?.filename || null,
            state: item?.state || null,
          });
        });
      }, 300);
    });
  });
}

// ========== 消息监听 ==========

// 监听扩展图标点击
chrome.action.onClicked.addListener((tab) => {
  console.log('[AI Export] Extension icon clicked, tab:', tab.url);
});

// 监听来自 content script 或 popup 的消息
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  console.log('[AI Export] Received message:', message.type);

  switch (message.type) {
    case 'EXPORT_REQUEST':
      handleExportRequest(message.data, sendResponse);
      return true;

    case 'GET_EXPORT_SETTINGS':
      chrome.storage.local.get(['exportSettings'], (result) => {
        sendResponse(result.exportSettings || getDefaultSettings());
      });
      return true;

    case 'SAVE_EXPORT_SETTINGS':
      chrome.storage.local.set({ exportSettings: message.settings }, () => {
        sendResponse({ success: true });
      });
      return true;

    case 'DOWNLOAD_FILE':
      downloadFile(message.filename, message.content, message.mimeType || message.type)
        .then(result => sendResponse({ success: true, ...result }))
        .catch(error => sendResponse({ success: false, error: error.message }));
      return true;

    default:
      sendResponse({ error: 'Unknown message type' });
  }
});

// 处理导出请求
async function handleExportRequest(data, sendResponse) {
  try {
    const { conversation, settings } = data;
    const markdown = convertToMarkdown(conversation, settings);
    const filename = generateFilename(conversation, settings);

    const downloadResult = await downloadFile(filename, markdown, 'text/markdown');
    sendResponse({
      success: true,
      filename,
      ...downloadResult,
    });
  } catch (error) {
    console.error('[AI Export] Export failed:', error);
    sendResponse({ success: false, error: error.message });
  }
}

// 初始化存储
chrome.storage.local.get(['exportSettings'], (result) => {
  if (!result.exportSettings) {
    chrome.storage.local.set({ exportSettings: getDefaultSettings() });
  }
});

console.log('[AI Export] Background service worker initialized');

// exporter.js - Markdown 导出转换器
// 负责将捕获的会话数据转换为格式化的 Markdown 输出

import { htmlToMarkdown, extractReferences, extractCodeBlocks } from './html-to-markdown.js';

/**
 * 导出配置
 */
export const defaultExportSettings = {
  includeTimestamp: true,
  includeModelInfo: true,
  includeReferences: true,
  includeReasoningSummary: true,
  includeCodeBlocks: true,
  format: 'markdown', // 'markdown' | 'json' | 'html'
  filenameTemplate: '{title}_{timestamp}.md',
  dateFormat: 'YYYY-MM-DD HH:mm:ss',
};

/**
 * 转换会话为 Markdown
 */
export function convertToMarkdown(conversation, settings = {}) {
  const opts = { ...defaultExportSettings, ...settings };
  let md = '';

  // 1. 生成 YAML Front Matter（如果包含模型信息）
  if (opts.includeModelInfo) {
    md += generateFrontMatter(conversation, opts);
  }

  // 2. 生成消息内容
  const messagesMd = conversation.messages?.map(msg =>
    convertMessageToMarkdown(msg, opts)
  ).join('\n') || '';

  md += messagesMd;

  // 3. 添加汇总信息
  md += generateSummary(conversation, opts);

  return md;
}

/**
 * 生成 YAML Front Matter
 */
function generateFrontMatter(conversation, opts) {
  const lines = ['---'];

  // 标题
  const title = conversation.title || extractTitleFromMessages(conversation.messages);
  lines.push(`标题：${title}`);

  // 平台
  if (conversation.platform) {
    lines.push(`平台：${conversation.platform}`);
  }

  // 模型
  if (conversation.model) {
    lines.push(`模型：${conversation.model}`);
  }

  // 时间信息
  if (conversation.createTime) {
    lines.push(`创建时间：${formatDate(conversation.createTime, opts.dateFormat)}`);
  }
  if (conversation.updateTime) {
    lines.push(`更新时间：${formatDate(conversation.updateTime, opts.dateFormat)}`);
  }

  // 导出时间
  lines.push(`导出时间：${formatDate(new Date().toISOString(), opts.dateFormat)}`);

  // URL（如果有）
  if (conversation.url) {
    lines.push(`URL：${conversation.url}`);
  }

  // 消息数量
  const msgCount = conversation.messages?.length || 0;
  lines.push(`消息数量：${msgCount}`);

  lines.push('---\n');
  return lines.join('\n');
}

/**
 * 转换单条消息为 Markdown
 */
function convertMessageToMarkdown(message, opts) {
  let md = '';

  // 角色标识
  const roleLabel = message.role === 'user' ? '👤 用户' : '🤖 AI';
  md += `\n## ${roleLabel}`;

  // 时间戳
  if (opts.includeTimestamp && message.createdAt) {
    md += ` *(${formatDate(message.createdAt, opts.dateFormat)})*`;
  }
  md += `\n\n`;

  // 模型信息（如果是 AI 回复）
  if (opts.includeModelInfo && message.model && message.role === 'assistant') {
    md += `> 模型：${message.model}\n\n`;
  }

  // 思考过程
  if (opts.includeReasoningSummary && message.reasoning_summary) {
    md += `<details>\n<summary>💭 思考过程</summary>\n\n`;
    md += message.reasoning_summary;
    md += `\n\n</details>\n\n`;
  }

  // 主要内容
  if (message.contentMarkdown) {
    md += message.contentMarkdown;
  } else if (message.contentHtml) {
    md += htmlToMarkdown(message.contentHtml);
  } else if (message.contentText) {
    md += message.contentText;
  }

  md += `\n\n`;

  // 引用来源
  if (opts.includeReferences && message.citations?.length > 0) {
    md += `### 引用来源\n\n`;
    message.citations.forEach((cite, idx) => {
      md += `${idx + 1}. `;
      if (cite.url) {
        md += `[${cite.title || '无标题'}](${cite.url})`;
      } else {
        md += cite.title || '无标题';
      }
      md += `\n`;
    });
    md += `\n`;
  }

  // 附件
  if (message.attachments?.length > 0) {
    md += `### 附件\n\n`;
    message.attachments.forEach((att, idx) => {
      md += `${idx + 1}. 📎 ${att.name || '附件'}`;
      if (att.url) {
        md += ` - [下载](${att.url})`;
      }
      md += `\n`;
    });
    md += `\n`;
  }

  md += `---\n\n`;

  return md;
}

/**
 * 生成汇总信息
 */
function generateSummary(conversation, opts) {
  if (!conversation.messages?.length) return '';

  const lines = ['\n---\n\n## 导出统计\n\n'];

  const messages = conversation.messages;
  const userMessages = messages.filter(m => m.role === 'user');
  const assistantMessages = messages.filter(m => m.role === 'assistant');

  lines.push(`- 总消息数：${messages.length}`);
  lines.push(`- 用户消息：${userMessages.length}`);
  lines.push(`- AI 回复：${assistantMessages.length}`);

  // 代码块统计
  let totalCodeBlocks = 0;
  messages.forEach(msg => {
    if (msg.contentHtml) {
      totalCodeBlocks += extractCodeBlocks(msg.contentHtml).length;
    }
  });
  if (totalCodeBlocks > 0) {
    lines.push(`- 代码块数量：${totalCodeBlocks}`);
  }

  // 引用统计
  let totalReferences = 0;
  messages.forEach(msg => {
    if (msg.citations?.length) {
      totalReferences += msg.citations.length;
    }
  });
  if (totalReferences > 0) {
    lines.push(`- 引用数量：${totalReferences}`);
  }

  lines.push('');
  return lines.join('\n');
}

/**
 * 从消息中提取标题（用作备用）
 */
function extractTitleFromMessages(messages) {
  if (!messages?.length) return '未命名会话';

  // 找第一条用户消息
  const firstUserMsg = messages.find(m => m.role === 'user');
  if (!firstUserMsg) return '未命名会话';

  const text = firstUserMsg.contentText || firstUserMsg.contentMarkdown || '';
  // 取前 50 个字符作为标题
  const title = text.split('\n')[0].slice(0, 50).trim();
  return title || '未命名会话';
}

/**
 * 格式化日期
 */
function formatDate(dateString, format) {
  if (!dateString) return '';

  const date = new Date(dateString);
  if (isNaN(date.getTime())) return dateString;

  // 简单实现常用格式
  if (format === 'YYYY-MM-DD HH:mm:ss') {
    return date.toISOString().replace('T', ' ').slice(0, 19);
  }

  return date.toLocaleString();
}

/**
 * 生成文件名
 */
export function generateFilename(conversation, settings = defaultExportSettings) {
  const timestamp = new Date().toISOString()
    .replace(/T/, '_')
    .replace(/:/g, '-')
    .slice(0, -5); // 去掉秒的小数部分

  const title = (conversation.title || extractTitleFromMessages(conversation.messages))
    .replace(/[\\/:*?"<>|]/g, '_')
    .slice(0, 50);

  return settings.filenameTemplate
    .replace('{title}', title)
    .replace('{timestamp}', timestamp)
    .replace('{platform}', conversation.platform || 'ai');
}

/**
 * 转换为 JSON 格式
 */
export function convertToJson(conversation) {
  return JSON.stringify(conversation, null, 2);
}

/**
 * 转换为简单文本格式
 */
export function convertToPlainText(conversation) {
  const lines = [];

  lines.push(`会话导出 - ${conversation.title || '未命名'}`);
  lines.push(`平台：${conversation.platform || '未知'}`);
  lines.push(`导出时间：${new Date().toLocaleString()}`);
  lines.push('='.repeat(50));
  lines.push('');

  conversation.messages?.forEach(msg => {
    const roleLabel = msg.role === 'user' ? '用户' : 'AI';
    lines.push(`[${roleLabel}]`);

    if (msg.contentText) {
      lines.push(msg.contentText);
    } else if (msg.contentMarkdown) {
      lines.push(msg.contentMarkdown);
    }

    lines.push('-'.repeat(30));
    lines.push('');
  });

  return lines.join('\n');
}

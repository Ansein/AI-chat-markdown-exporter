// chatgpt.js - ChatGPT 平台适配模块

(function(global) {
  'use strict';

  const ChatGPTPlatform = {
    name: 'chatgpt',
    displayName: 'ChatGPT',
    urlPatterns: [
      'chatgpt.com',
      'chat.openai.com',
    ],
    selectors: {
      messageContainer: '[data-message-author-role]',
      userMessage: '[data-message-author-role="user"]',
      assistantMessage: '[data-message-author-role="assistant"]',
      messageContent: '[data-message-content]',
      timestamp: 'time',
      modelInfo: '[data-model], [class*="model"]',
      thinking: '[class*="thinking"], [class*="reasoning"], details',
      citations: '[class*="citation"], [class*="reference"], a[href^="http"]',
    },
    apiPatterns: [
      '/backend-api/conversation',
      '/v1/chat/completions',
      '/api/conversation',
    ],
    features: {
      networkInterception: true,
      domParsing: true,
      conversationList: true,
      dynamicContent: true,
    },

    async extractData() {
      console.log('[AI Export] Extracting ChatGPT data...');

      await this.waitForElement('[data-message-author-role]', 5000).catch(() => {});

      const messages = [];
      const messageElements = document.querySelectorAll('[data-message-author-role]');

      messageElements.forEach((el, index) => {
        try {
          const message = this.extractMessageFromElement(el, index);
          if (message) messages.push(message);
        } catch (err) {
          console.error('[AI Export] Failed to extract ChatGPT message:', err);
        }
      });

      const globalData = window.__CHATGPT_DATA__ || {};

      return {
        messages: this.sortMessages(messages),
        model: globalData.model,
        createTime: globalData.createTime,
        meta: globalData,
      };
    },

    extractMessageFromElement(el, index) {
      const role = el.getAttribute('data-message-author-role');
      const contentEl = el.querySelector('[data-message-content]') || el;
      const timestamp = this.extractTimestamp(el);
      const model = this.extractModel(el);

      const message = {
        id: `msg-${index}`,
        role: role === 'user' ? 'user' : 'assistant',
        createdAt: timestamp,
        model: model,
        contentHtml: contentEl.innerHTML,
        contentText: contentEl.textContent,
        contentMarkdown: global.HtmlToMarkdown?.convert(contentEl.innerHTML) || '',
        citations: this.extractCitations(el),
      };

      const thinking = this.extractThinking(el);
      if (thinking) {
        message.reasoning_summary = thinking;
      }

      return message;
    },

    extractTimestamp(element) {
      const timeEl = element.querySelector('time');
      if (timeEl) {
        return timeEl.getAttribute('datetime') || timeEl.textContent;
      }

      const datetime = element.getAttribute('data-timestamp') ||
                       element.getAttribute('data-created-at');
      if (datetime) return datetime;

      return null;
    },

    extractModel(element) {
      const modelEl = element.querySelector('[class*="model"], [data-model]');
      return modelEl?.getAttribute('data-model') || modelEl?.textContent;
    },

    extractCitations(element) {
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
    },

    extractThinking(element) {
      const thinkingSelectors = [
        '[class*="thinking"]',
        '[class*="reasoning"]',
        'details',
        '[data-thinking]',
      ];

      for (const selector of thinkingSelectors) {
        const thinkingEl = element.querySelector(selector);
        if (thinkingEl) {
          if (thinkingEl.tagName.toLowerCase() === 'details') {
            const summary = thinkingEl.querySelector('summary');
            const dc = summary ? thinkingEl.innerHTML.replace(summary.outerHTML, '') : thinkingEl.innerHTML;
            const tempDiv = document.createElement('div');
            tempDiv.innerHTML = dc;
            return tempDiv.textContent?.trim() || null;
          }
          return thinkingEl.textContent?.trim() || null;
        }
      }

      return null;
    },

    sortMessages(messages) {
      return messages.sort((a, b) => {
        if (a.createdAt && b.createdAt) {
          return new Date(a.createdAt) - new Date(b.createdAt);
        }
        return 0;
      });
    },

    async waitForElement(selector, timeout = 5000) {
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
    },

    async extractConversationList() {
      console.log('[AI Export] Extracting ChatGPT conversation list...');

      const conversations = [];
      const selectors = [
        'nav a[href*="/c/"]',
        'aside a[href*="/c/"]',
        '[data-testid*="conversation"]',
        'a[href*="/conversation/"]',
      ];

      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        elements.forEach(el => {
          const href = el.getAttribute('href') || '';
          const idMatch = href.match(/\/(?:c|conversation)\/([a-zA-Z0-9-_]+)/);
          const id = idMatch ? idMatch[1] : null;

          if (id) {
            const title = el.textContent?.trim() || '';
            if (title && !conversations.find(c => c.id === id)) {
              conversations.push({
                id,
                title,
                url: href.startsWith('http') ? href : `https://chatgpt.com${href}`,
                platform: 'chatgpt',
              });
            }
          }
        });
      }

      return conversations;
    },

    parseApiResponse(data) {
      if (!data) return null;

      const messages = [];
      const conversation = data.conversation || {};

      if (Array.isArray(data.messages)) {
        data.messages.forEach(msg => {
          if (!msg.id || !msg.author) return;

          const role = msg.author && msg.author.role ? msg.author.role : msg.role;
          let content = '';

          if (msg.content && msg.content.parts && Array.isArray(msg.content.parts)) {
            content = msg.content.parts.map(p => {
              if (typeof p === 'string') return p;
              if (p && p.text) return p.text;
              return '';
            }).join('');
          } else if (msg.content && msg.content.text) {
            content = msg.content.text;
          } else if (typeof msg.content === 'string') {
            content = msg.content;
          }

          messages.push({
            id: msg.id,
            role: role === 'user' ? 'user' : 'assistant',
            contentText: content,
            contentMarkdown: content,
            createdAt: msg.create_time ? new Date(msg.create_time * 1000).toISOString() : null,
            model: (msg.metadata && msg.metadata.model) ? msg.metadata.model : null,
            citations: this.extractCitationsFromData(msg),
            reasoning_summary: msg.metadata?.reasoning_content || null,
          });
        });
      }

      return {
        messages,
        metadata: {
          conversationId: (conversation && conversation.id) ? conversation.id : data.conversation_id,
          title: (conversation && conversation.title) ? conversation.title : null,
          model: data.model,
        },
      };
    },

    extractCitationsFromData(msg) {
      const citations = [];
      const metadata = msg.metadata || msg.citations || msg.references;

      if (Array.isArray(metadata)) {
        metadata.forEach((cite, index) => {
          citations.push({
            index: index + 1,
            url: cite.url || cite.link,
            title: cite.title || cite.name,
          });
        });
      } else if (metadata && typeof metadata === 'object') {
        Object.keys(metadata).forEach((key, index) => {
          const cite = metadata[key];
          if (cite && cite.url) {
            citations.push({
              index: index + 1,
              url: cite.url,
              title: cite.title,
            });
          }
        });
      }

      return citations;
    },
  };

  global.ChatGPTPlatform = ChatGPTPlatform;

  if (global.PlatformManager && typeof global.PlatformManager.register === 'function') {
    global.PlatformManager.register(ChatGPTPlatform);
    console.log('[AI Export] ChatGPT platform registered');
  } else {
    console.warn('[AI Export] PlatformManager not available, ChatGPTPlatform exposed but not registered');
  }

})(typeof window !== 'undefined' ? window : this);

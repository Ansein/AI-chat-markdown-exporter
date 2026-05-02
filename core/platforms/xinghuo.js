// xinghuo.js - 讯飞星火 平台适配模块

(function(global) {
  'use strict';

  if (!global.PlatformManager) {
    console.error('[AI Export] PlatformManager not found, skipping XingHuo registration');
    return;
  }

  const XingHuoPlatform = {
    name: 'xinghuo',
    displayName: '讯飞星火',
    urlPatterns: [
      'xinghuo.xfyun.cn',
      'sparkdesk.xfyun.cn',
    ],
    selectors: {
      messageContainer: '[class*="message"], [class*="chat-item"], [class*="conversation-item"]',
      userMessage: '[class*="user-message"], [class*="user-msg"], [class*="question"]',
      assistantMessage: '[class*="ai-message"], [class*="assistant-msg"], [class*="answer"], [class*="response"]',
      messageContent: '[class*="content"], [class*="message-content"], [class*="text"]',
      timestamp: 'time, [data-time], [class*="time"]',
      modelInfo: '[class*="model"], [data-model], [class*="version"]',
      thinking: '[class*="thinking"], [class*="reasoning"], [class*="thought"], details',
      citations: '[class*="citation"], [class*="reference"], [class*="source"], a[href^="http"]',
    },
    apiPatterns: [
      '/api/chat',
      '/api/conversation',
      '/api/message',
      '/backend-api',
      '/v1/chat',
    ],
    features: {
      networkInterception: true,
      domParsing: true,
      conversationList: true,
      dynamicContent: true,
    },

    async extractData() {
      console.log('[AI Export] Extracting XingHuo data...');

      const apiData = window.__AI_EXPORT__?.getData?.();
      if (apiData?.messages?.length > 0) {
        console.log('[AI Export] Using API-intercepted data:', apiData.messages.length, 'messages');
        return {
          messages: this.sortMessages(apiData.messages),
          model: apiData.metadata?.model,
          meta: apiData.metadata || {},
        };
      }

      return this.extractDataFromDOM();
    },

    async extractDataFromDOM() {
      console.log('[AI Export] Extracting XingHuo data from DOM...');

      await this.waitForElement('[class*="message"], [class*="chat-item"]', 5000).catch(() => {});

      const messages = [];
      const allElements = [];

      const userSelectors = [
        '[class*="user-message"]',
        '[class*="user-msg"]',
        '[class*="question"]',
        '[class*="my-message"]',
        '[class*="left-message"]',
      ];

      const assistantSelectors = [
        '[class*="ai-message"]',
        '[class*="assistant-msg"]',
        '[class*="answer"]',
        '[class*="response"]',
        '[class*="bot-message"]',
        '[class*="right-message"]',
      ];

      for (const selector of userSelectors) {
        document.querySelectorAll(selector).forEach(el => {
          allElements.push({ el, type: 'user' });
        });
      }

      for (const selector of assistantSelectors) {
        document.querySelectorAll(selector).forEach(el => {
          allElements.push({ el, type: 'assistant' });
        });
      }

      const sortedElements = this.sortElementsByPosition(allElements.map(item => item.el))
        .map(el => allElements.find(item => item.el === el))
        .filter(item => item);

      sortedElements.forEach((item, index) => {
        try {
          const msg = this.extractMessageFromElement(item.el, item.type, index);
          if (msg) messages.push(msg);
        } catch (err) {
          console.error('[AI Export] Failed to extract XingHuo message:', err);
        }
      });

      if (messages.length === 0) {
        messages.push(...this.extractMessagesGeneric());
      }

      return {
        messages: this.sortMessages(messages),
      };
    },

    extractMessageFromElement(el, type, index) {
      const message = {
        id: `msg-${index}`,
        role: type === 'user' ? 'user' : 'assistant',
      };

      const contentSelectors = [
        '[class*="content"]',
        '[class*="message-content"]',
        '[class*="text"]',
        '[class*="markdown"]',
        '[class*="bubble"]',
      ];

      let contentEl = null;
      for (const selector of contentSelectors) {
        const found = el.querySelector(selector);
        if (found) {
          contentEl = found;
          break;
        }
      }

      if (!contentEl) {
        contentEl = el;
      }

      message.contentHtml = contentEl.innerHTML;
      message.contentText = contentEl.textContent?.trim() || '';
      message.contentMarkdown = global.HtmlToMarkdown?.convert(contentEl.innerHTML) || '';
      message.createdAt = this.extractTimestamp(el);

      const codeBlocks = this.extractCodeBlocks(contentEl);
      if (codeBlocks.length > 0) {
        message.codeBlocks = codeBlocks;
      }

      if (type === 'assistant') {
        const thinking = this.extractThinking(el);
        if (thinking) {
          message.reasoning_summary = thinking;
        }

        message.citations = this.extractCitations(el);
        message.model = this.extractModel(el);
      }

      return message;
    },

    extractMessagesGeneric() {
      const messages = [];
      const mainEl = document.querySelector('[role="main"], [class*="main"], [class*="chat-container"], [class*="conversation-container"]');

      if (!mainEl) return messages;

      const allBlocks = mainEl.querySelectorAll('div[class*="message"], div[class*="chat-item"], div[class*="conversation"], div[class*="bubble"], [class*="item"]');
      let lastRole = null;

      allBlocks.forEach((el, index) => {
        const text = el.textContent?.trim() || '';
        if (text.length < 10) return;

        const isUser = this.isUserMessage(el);
        let role = isUser ? 'user' : 'assistant';

        if (role === lastRole && lastRole !== null) {
          return;
        }

        messages.push({
          id: `msg-${index}`,
          role,
          contentText: text,
          contentHtml: el.innerHTML,
          contentMarkdown: global.HtmlToMarkdown?.convert(el.innerHTML) || '',
        });

        lastRole = role;
      });

      return messages;
    },

    isUserMessage(el) {
      const userClasses = ['user', 'my', 'question', 'left', 'send', 'self'];
      const assistantClasses = ['ai', 'bot', 'assistant', 'answer', 'response', 'right', 'receive'];

      const className = (el.className || '').toLowerCase();

      for (const cls of userClasses) {
        if (className.includes(cls)) return true;
      }

      for (const cls of assistantClasses) {
        if (className.includes(cls)) return false;
      }

      return el.getAttribute('data-role') === 'user' ||
             el.getAttribute('data-type') === 'user';
    },

    extractTimestamp(element) {
      const timeEl = element.querySelector('time, [data-time], [data-timestamp], [class*="time"]');
      if (timeEl) {
        return timeEl.getAttribute('datetime') ||
               timeEl.getAttribute('data-time') ||
               timeEl.getAttribute('data-timestamp') ||
               timeEl.textContent;
      }
      return null;
    },

    extractModel(element) {
      const modelEl = element.querySelector('[class*="model"], [data-model], [class*="version"]');
      return modelEl?.getAttribute('data-model') || modelEl?.textContent?.trim() || null;
    },

    extractCitations(element) {
      const citations = [];
      const selectors = [
        '[class*="citation"]',
        '[class*="reference"]',
        '[class*="source"]',
        '[class*="link"]',
        'a[href^="http"]',
      ];

      for (const selector of selectors) {
        element.querySelectorAll(selector).forEach((cite, index) => {
          const url = cite.getAttribute('href') || cite.getAttribute('data-url') || '';
          if (url && url.startsWith('http')) {
            citations.push({
              index: citations.length + 1,
              url: url,
              title: cite.getAttribute('title') || cite.textContent?.slice(0, 100) || url,
            });
          }
        });
      }

      return citations;
    },

    extractCodeBlocks(element) {
      const blocks = [];
      element.querySelectorAll('pre, code, [class*="code"]').forEach((el, index) => {
        blocks.push({
          index: index + 1,
          language: el.getAttribute('data-lang') || el.getAttribute('data-language') || el.getAttribute('lang') || 'text',
          code: el.textContent?.trim() || '',
        });
      });
      return blocks;
    },

    extractThinking(element) {
      const thinkingSelectors = [
        '[class*="thinking"]',
        '[class*="reasoning"]',
        '[class*="thought"]',
        '[class*="thinking-process"]',
        '[class*="thought-process"]',
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

    sortElementsByPosition(elements) {
      return [...elements].sort((a, b) => {
        const pos = a.compareDocumentPosition(b);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
      });
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
      console.log('[AI Export] Extracting XingHuo conversation list...');

      const conversations = [];
      const selectors = [
        'nav a[href*="/chat/"]',
        'nav a[href*="/conversation/"]',
        'aside a[href*="/chat/"]',
        'aside a[href*="/conversation/"]',
        '[class*="history-item"] a',
        '[class*="conversation-item"] a',
        '[class*="chat-item"] a',
        '[class*="session-item"] a',
      ];

      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        elements.forEach(el => {
          const href = el.getAttribute('href') || '';
          const idMatch = href.match(/\/(?:chat|conversation|c|session)\/([a-zA-Z0-9-_]+)/);
          const id = idMatch ? idMatch[1] : null;

          if (id || href) {
            const title = el.textContent?.trim() || '';
            if (title) {
              const convId = id || `xinghuo-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;
              if (!conversations.find(c => c.id === convId)) {
                conversations.push({
                  id: convId,
                  title,
                  url: href.startsWith('http') ? href : `https://xinghuo.xfyun.cn${href}`,
                  platform: 'xinghuo',
                });
              }
            }
          }
        });
      }

      return conversations;
    },

    parseApiResponse(data) {
      if (!data) return null;

      const messages = [];

      if (data.messages && Array.isArray(data.messages)) {
        data.messages.forEach((msg, index) => {
          const role = msg.role || (msg.sender === 'user' ? 'user' : 'assistant');
          let content = '';

          if (typeof msg.content === 'string') {
            content = msg.content;
          } else if (msg.content && Array.isArray(msg.content)) {
            content = msg.content.map(c => c.text || c.content || '').join('');
          } else if (msg.text) {
            content = msg.text;
          } else if (msg.choices && Array.isArray(msg.choices)) {
            content = msg.choices.map(c => c.delta?.content || c.message?.content || '').join('');
          }

          messages.push({
            id: msg.id || `msg-${index}`,
            role: role === 'user' ? 'user' : 'assistant',
            contentText: content,
            contentMarkdown: content,
            createdAt: msg.created_at || msg.timestamp || msg.time || null,
            model: msg.model || null,
            reasoning_summary: msg.thinking || msg.reasoning || msg.thought || null,
          });
        });
      }

      if (data.choices && Array.isArray(data.choices) && messages.length === 0) {
        const content = data.choices.map(c => c.delta?.content || c.message?.content || '').join('');
        if (content) {
          messages.push({
            id: `msg-${Date.now()}`,
            role: 'assistant',
            contentText: content,
            contentMarkdown: content,
            createdAt: data.created ? new Date(data.created * 1000).toISOString() : null,
            model: data.model || null,
            reasoning_summary: null,
          });
        }
      }

      if (data.result || data.content || data.text) {
        const content = data.result || data.content || data.text || '';
        if (content && messages.length === 0) {
          messages.push({
            id: `msg-${Date.now()}`,
            role: 'assistant',
            contentText: content,
            contentMarkdown: content,
            createdAt: data.created_at || null,
            model: data.model || null,
            reasoning_summary: data.thinking || data.reasoning || null,
          });
        }
      }

      return {
        messages,
        metadata: {
          conversationId: data.conversationId || data.conversation_id || data.id || data.session_id,
          title: data.title,
          model: data.model,
        },
      };
    },
  };

  global.PlatformManager.register(XingHuoPlatform);
  console.log('[AI Export] XingHuo platform registered');

  global.XingHuoPlatform = XingHuoPlatform;

})(typeof window !== 'undefined' ? window : this);

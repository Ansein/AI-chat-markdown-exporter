// claude.js - Claude 平台适配模块

(function(global) {
  'use strict';

  const ClaudePlatform = {
    name: 'claude',
    displayName: 'Claude',
    urlPatterns: [
      'claude.ai',
      'anthropic.com',
    ],
    selectors: {
      messageContainer: '[data-testid="user-message"], .font-claude-response',
      userMessage: '[data-testid="user-message"]',
      assistantMessage: '.font-claude-response',
      messageContent: 'div[class*="prose"]',
      timestamp: 'time, [data-time]',
      modelInfo: '[data-model], [class*="model"]',
      thinking: '[class*="thinking"], [class*="reasoning"], details',
      citations: '[class*="citation"], [class*="reference"], a[href^="http"]',
    },
    apiPatterns: [
      '/api/organizations',
      '/api/conversations',
      '/api/chat_conversations',
    ],
    features: {
      networkInterception: true,
      domParsing: true,
      conversationList: true,
      dynamicContent: true,
    },

    async extractData() {
      console.log('[AI Export] Extracting Claude data...');

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
      console.log('[AI Export] Extracting Claude data from DOM...');

      await this.waitForElement('[data-testid="user-message"], .font-claude-response', 5000).catch(() => {});

      const allElements = [];

      document.querySelectorAll('[data-testid="user-message"]').forEach(el => {
        allElements.push({ el, type: 'user' });
      });

      document.querySelectorAll('.font-claude-response').forEach(el => {
        allElements.push({ el, type: 'assistant' });
      });

      const sortedElements = [...allElements.map(item => item.el)].sort((a, b) => {
        const pos = a.compareDocumentPosition(b);
        if (pos & Node.DOCUMENT_POSITION_FOLLOWING) return -1;
        if (pos & Node.DOCUMENT_POSITION_PRECEDING) return 1;
        return 0;
      }).map(el => allElements.find(item => item.el === el));

      const messages = [];

      sortedElements.forEach((item, index) => {
        try {
          const msg = this.extractMessageFromElement(item.el, item.type, index);
          if (msg) messages.push(msg);
        } catch (err) {
          console.error('[AI Export] Failed to extract Claude message:', err);
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

      if (type === 'user') {
        message.contentText = el.textContent?.trim() || '';
        message.contentHtml = el.innerHTML;
        message.contentMarkdown = global.HtmlToMarkdown?.convert(el.innerHTML) || '';

        const attachments = [];
        el.querySelectorAll('[data-testid="file-thumbnail"]').forEach(ft => {
          attachments.push({
            name: ft.textContent?.trim() || ft.getAttribute('data-file-name') || 'attachment',
          });
        });

        if (attachments.length > 0) {
          message.attachments = attachments;
        }
      } else {
        const proseEl = el.querySelector('div[class*="prose"]') || el;
        message.contentHtml = proseEl.innerHTML;
        message.contentText = proseEl.textContent?.trim() || '';
        message.contentMarkdown = global.HtmlToMarkdown?.convert(proseEl.innerHTML) || '';

        const turnContainer = el.closest('[data-test-render-count]') || el.parentElement;
        if (turnContainer) {
          const thinking = this.extractThinking(turnContainer);
          if (thinking) {
            message.reasoning_summary = thinking;
          }
        }

        message.citations = this.extractCitations(el);
      }

      message.createdAt = this.extractTimestamp(el);

      return message;
    },

    extractMessagesGeneric() {
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

        if (role === lastRole) {
          role = role === 'user' ? 'assistant' : 'user';
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

    extractTimestamp(element) {
      const timeEl = element.querySelector('time, [data-time], [data-timestamp]');
      if (timeEl) {
        return timeEl.getAttribute('datetime') ||
               timeEl.getAttribute('data-time') ||
               timeEl.getAttribute('data-timestamp') ||
               timeEl.textContent;
      }
      return null;
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
      console.log('[AI Export] Extracting Claude conversation list...');

      const conversations = [];
      const selectors = [
        'nav a[href*="/chat/"]',
        'aside a[href*="/chat/"]',
        '[data-testid*="conversation"]',
        'a[href*="/conversation/"]',
      ];

      for (const selector of selectors) {
        const elements = document.querySelectorAll(selector);
        elements.forEach(el => {
          const href = el.getAttribute('href') || '';
          const idMatch = href.match(/\/(?:chat|conversation)\/([a-zA-Z0-9-_]+)/);
          const id = idMatch ? idMatch[1] : null;

          if (id) {
            const title = el.textContent?.trim() || '';
            if (title && !conversations.find(c => c.id === id)) {
              conversations.push({
                id,
                title,
                url: href.startsWith('http') ? href : `https://claude.ai${href}`,
                platform: 'claude',
              });
            }
          }
        });
      }

      return conversations;
    },

    parseApiResponse(data) {
      if (!data) return null;

      if (data.children && Array.isArray(data.children)) {
        return this.parseConversationTree(data);
      }

      if (data.completion || data.content) {
        return this.parseSingleMessage(data);
      }

      if (data.messages) {
        return this.parseMessagesArray(data);
      }

      return null;
    },

    parseConversationTree(data) {
      const messages = [];

      const flattenMessageTree = (node) => {
        if (!node) return;

        if (node.sender && node.content) {
          const role = node.sender === 'human' ? 'user' : 'assistant';
          let textContent = '';
          let reasoningText = '';
          const citations = [];
          const model = node.model;

          if (Array.isArray(node.content)) {
            for (const block of node.content) {
              if (block.type === 'text' && block.text) {
                textContent += block.text;
              } else if (block.type === 'thinking' && block.thinking) {
                reasoningText += block.thinking;
              } else if (block.type === 'tool_use' && block.name === 'web_search') {
                if (block.input && block.input.query) {
                  citations.push({
                    url: 'https://www.google.com/search?q=' + encodeURIComponent(block.input.query),
                    title: 'Search: ' + block.input.query,
                  });
                }
              } else if (block.type === 'tool_result' && block.content) {
                if (typeof block.content === 'string') {
                  const urls = block.content.match(/https?:\/\/[^\s"<>]+/g);
                  if (urls) {
                    urls.forEach(u => {
                      citations.push({ url: u, title: u });
                    });
                  }
                }
              }
            }
          } else if (typeof node.content === 'string') {
            textContent = node.content;
          }

          if (textContent) {
            messages.push({
              id: node.uuid || ('msg-' + messages.length),
              role: role,
              contentText: textContent,
              contentMarkdown: textContent,
              createdAt: node.created_at ? new Date(node.created_at).toISOString() : null,
              model: model || null,
              reasoning_summary: reasoningText || null,
              citations: citations.length > 0 ? citations : null,
            });
          }
        }

        if (Array.isArray(node.children)) {
          for (const child of node.children) {
            flattenMessageTree(child);
          }
        }
      };

      flattenMessageTree(data);

      return {
        messages,
        metadata: {
          conversationId: data.uuid || null,
          title: data.name || null,
          model: data.model || null,
        },
      };
    },

    parseSingleMessage(data) {
      const messages = [];

      if (data.completion) {
        messages.push({
          id: data.id || ('msg-' + Date.now()),
          role: 'assistant',
          contentText: data.completion,
          contentMarkdown: data.completion,
          createdAt: data.created_at ? new Date(data.created_at).toISOString() : null,
        });
      }

      if (Array.isArray(data.content)) {
        for (const block of data.content) {
          if (block.type === 'text' && block.text) {
            messages.push({
              id: data.id || ('msg-' + Date.now()),
              role: 'assistant',
              contentText: block.text,
              contentMarkdown: block.text,
            });
          } else if (block.type === 'thinking' && block.thinking) {
            if (messages.length === 0) {
              messages.push({
                id: data.id || ('msg-' + Date.now()),
                role: 'assistant',
                contentText: '',
                contentMarkdown: '',
                reasoning_summary: block.thinking,
              });
            } else {
              messages[messages.length - 1].reasoning_summary = block.thinking;
            }
          }
        }
      }

      return {
        messages,
        metadata: {
          model: data.model,
        },
      };
    },

    parseMessagesArray(data) {
      const messages = [];

      if (Array.isArray(data.messages)) {
        data.messages.forEach(msg => {
          const role = msg.role || (msg.sender === 'human' ? 'user' : 'assistant');
          let content = '';

          if (typeof msg.content === 'string') {
            content = msg.content;
          } else if (msg.content && Array.isArray(msg.content)) {
            content = msg.content.map(c => c.text || '').join('');
          }

          messages.push({
            id: msg.id || ('msg-' + messages.length),
            role: role === 'user' ? 'user' : 'assistant',
            contentText: content,
            contentMarkdown: content,
            createdAt: msg.created_at || msg.timestamp || null,
          });
        });
      }

      return {
        messages,
        metadata: {
          conversationId: data.conversationId || data.conversation_id,
          title: data.title,
        },
      };
    },
  };

  global.ClaudePlatform = ClaudePlatform;

  if (global.PlatformManager && typeof global.PlatformManager.register === 'function') {
    global.PlatformManager.register(ClaudePlatform);
    console.log('[AI Export] Claude platform registered');
  } else {
    console.warn('[AI Export] PlatformManager not available, ClaudePlatform exposed but not registered');
  }

})(typeof window !== 'undefined' ? window : this);

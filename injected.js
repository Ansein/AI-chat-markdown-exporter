// injected.js - 页面注入脚本
// 运行在页面上下文中，负责拦截网络请求和读取页面状态
// 增强版：支持多平台、动态内容、更好的异常处理

(function(global) {
  'use strict';

  console.log('[AI Export] Injected script initialized (v2.0)');

  let capturedData = {
    conversations: [],
    messages: [],
    references: [],
    metadata: {}
  };

  let seenMessageIds = new Set();
  let networkInterceptionEnabled = true;

  const platformPatterns = {
    chatgpt: {
      name: 'chatgpt',
      urls: ['chatgpt.com', 'chat.openai.com'],
      apiPatterns: [
        '/backend-api/conversation',
        '/v1/chat/completions',
        '/api/conversation',
        '/backend-api/message',
      ],
    },
    claude: {
      name: 'claude',
      urls: ['claude.ai', 'anthropic.com'],
      apiPatterns: [
        '/api/organizations',
        '/api/conversations',
        '/api/chat_conversations',
        '/api/message',
      ],
    },
    yiyan: {
      name: 'yiyan',
      urls: ['yiyan.baidu.com', 'yiyan.baidu.com.cn'],
      apiPatterns: [
        '/api/chat',
        '/api/conversation',
        '/api/message',
        '/backend-api',
        '/v1/chat',
      ],
    },
    xinghuo: {
      name: 'xinghuo',
      urls: ['xinghuo.xfyun.cn', 'sparkdesk.xfyun.cn'],
      apiPatterns: [
        '/api/chat',
        '/api/conversation',
        '/api/message',
        '/backend-api',
        '/v1/chat',
      ],
    },
    tongyi: {
      name: 'tongyi',
      urls: ['tongyi.aliyun.com', 'qianwen.aliyun.com'],
      apiPatterns: [
        '/api/chat',
        '/api/conversation',
        '/api/message',
        '/backend-api',
        '/v1/chat',
        '/api/v1',
      ],
    },
    doubao: {
      name: 'doubao',
      urls: ['doubao.com'],
      apiPatterns: [
        '/api/chat',
        '/api/conversation',
        '/api/message',
        '/backend-api',
        '/v1/chat',
        '/api/v1',
      ],
    },
  };

  function getCurrentPlatform() {
    const url = window.location.href;
    for (const [key, platform] of Object.entries(platformPatterns)) {
      if (platform.urls.some(p => url.includes(p))) {
        return platform;
      }
    }
    return null;
  }

  function sendDataToContentScript(data) {
    try {
      window.dispatchEvent(new CustomEvent('AIExportData', {
        detail: data
      }));
    } catch (error) {
      console.error('[AI Export] Failed to send data to content script:', error);
    }
  }

  function isAIRequest(url) {
    if (!url || typeof url !== 'string') return false;

    const lower = url.toLowerCase();
    const patterns = [
      'chatgpt', 'openai', 'claude', 'anthropic',
      'conversation', 'chat/completions', '/api/chat',
      '/api/conversation', '/backend-api',
      'yiyan', 'xinghuo', 'sparkdesk', 'tongyi', 'qianwen', 'doubao',
      '/message', '/api/message',
    ];

    return patterns.some(function(p) { return lower.indexOf(p) !== -1; });
  }

  const originalFetch = window.fetch;
  window.fetch = function(...args) {
    if (!networkInterceptionEnabled) {
      return originalFetch.apply(this, args);
    }

    const url = args[0]?.url || args[0];
    const options = args[1] || {};

    return originalFetch.apply(this, args).then(response => {
      if (!isAIRequest(url)) {
        return response;
      }

      const clonedResponse = response.clone();
      handleAIRequest(url, options, clonedResponse).catch(function(err) {
        console.warn('[AI Export] Failed to handle AI request:', err.message);
      });

      return response;
    }).catch(function(error) {
      console.warn('[AI Export] Fetch error:', error.message);
      throw error;
    });
  };

  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHRSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...restArgs) {
    this._url = url;
    this._method = method;
    return originalXHROpen.apply(this, [method, url, ...restArgs]);
  };

  XMLHttpRequest.prototype.send = function(body) {
    if (!networkInterceptionEnabled) {
      return originalXHRSend.apply(this, [body]);
    }

    const xhr = this;
    const url = this._url;

    if (isAIRequest(url)) {
      this.addEventListener('load', function() {
        try {
          handleAIRequest(url, {
            method: xhr._method,
            body: body,
            headers: {}
          }, {
            json: function() {
              try {
                return JSON.parse(this.responseText);
              } catch (e) {
                return null;
              }
            },
            text: function() { return this.responseText; },
            responseText: xhr.responseText
          }).catch(function(err) {
            console.warn('[AI Export] Failed to handle XHR:', err.message);
          });
        } catch (err) {
          console.warn('[AI Export] XHR response parse error:', err.message);
        }
      });
    }

    return originalXHRSend.apply(this, [body]);
  };

  async function handleAIRequest(url, options, response) {
    try {
      let data;
      try {
        data = await response.json();
      } catch(e) {
        const text = await response.text();
        if (text && (text.startsWith('{') || text.startsWith('['))) {
          try {
            data = JSON.parse(text);
          } catch (parseErr) {
            return;
          }
        } else {
          return;
        }
      }

      if (!data) return;

      const platform = getCurrentPlatform();
      console.log('[AI Export] AI response captured for platform:', platform?.name || 'unknown');

      const parsed = parseAIResponse(url, data, platform);
      if (parsed && parsed.messages && parsed.messages.length > 0) {
        const newMessages = parsed.messages.filter(function(m) {
          if (m.id && seenMessageIds.has(m.id)) return false;
          if (m.id) seenMessageIds.add(m.id);
          return true;
        });

        if (newMessages.length > 0) {
          capturedData.messages = capturedData.messages.concat(newMessages);
          capturedData.metadata = Object.assign({}, capturedData.metadata, parsed.metadata);

          sendDataToContentScript({
            type: 'MESSAGES_CAPTURED',
            messages: capturedData.messages,
            metadata: capturedData.metadata,
            platform: platform?.name,
          });
        }
      }
    } catch (err) {
      console.error('[AI Export] Failed to parse AI response:', err);
    }
  }

  function parseAIResponse(url, data, platform) {
    if (!data) return null;

    if (platform) {
      const platformParser = getPlatformParser(platform.name);
      if (platformParser) {
        return platformParser(data, url);
      }
    }

    return parseGenericResponse(data, url);
  }

  function getPlatformParser(platformName) {
    const parsers = {
      chatgpt: parseChatGPTResponse,
      claude: parseClaudeResponse,
      yiyan: parseCommonResponse,
      xinghuo: parseCommonResponse,
      tongyi: parseCommonResponse,
      doubao: parseCommonResponse,
    };
    return parsers[platformName] || parseGenericResponse;
  }

  function parseChatGPTResponse(data, url) {
    const messages = [];
    const conversation = data.conversation || {};

    if (Array.isArray(data.messages)) {
      data.messages.forEach(function(msg, index) {
        if (!msg.id) return;

        const role = (msg.author && msg.author.role) ? msg.author.role : msg.role;
        let content = '';

        if (msg.content && msg.content.parts && Array.isArray(msg.content.parts)) {
          content = msg.content.parts.map(function(p) {
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
          citations: extractCitationsFromData(msg),
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
  }

  function parseClaudeResponse(data, url) {
    if (data.children && Array.isArray(data.children)) {
      return parseClaudeConversationTree(data);
    }

    if (data.completion || data.content) {
      return parseClaudeSingleMessage(data);
    }

    if (data.messages) {
      return parseCommonResponse(data, url);
    }

    return null;
  }

  function parseClaudeConversationTree(data) {
    const messages = [];

    function flattenMessageTree(node) {
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
    }

    flattenMessageTree(data);

    return {
      messages,
      metadata: {
        conversationId: data.uuid || null,
        title: data.name || null,
        model: data.model || null,
      },
    };
  }

  function parseClaudeSingleMessage(data) {
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
  }

  function parseCommonResponse(data, url) {
    const messages = [];

    if (data.messages && Array.isArray(data.messages)) {
      data.messages.forEach(function(msg, index) {
        const role = msg.role || (msg.sender === 'user' ? 'user' : 'assistant');
        let content = '';

        if (typeof msg.content === 'string') {
          content = msg.content;
        } else if (msg.content && Array.isArray(msg.content)) {
          content = msg.content.map(function(c) {
            return c.text || c.content || '';
          }).join('');
        } else if (msg.text) {
          content = msg.text;
        } else if (msg.choices && Array.isArray(msg.choices)) {
          content = msg.choices.map(function(c) {
            return c.delta?.content || c.message?.content || '';
          }).join('');
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
      const content = data.choices.map(function(c) {
        return c.delta?.content || c.message?.content || '';
      }).join('');

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

    const contentFields = ['result', 'content', 'text', 'output', 'answer', 'response'];
    for (const field of contentFields) {
      if (data[field] && messages.length === 0) {
        const content = data[field];
        messages.push({
          id: `msg-${Date.now()}`,
          role: 'assistant',
          contentText: content,
          contentMarkdown: content,
          createdAt: data.created_at || null,
          model: data.model || null,
          reasoning_summary: data.thinking || data.reasoning || null,
        });
        break;
      }
    }

    return {
      messages,
      metadata: {
        conversationId: data.conversationId || data.conversation_id || data.id || data.session_id || data.dialog_id,
        title: data.title,
        model: data.model,
      },
    };
  }

  function parseGenericResponse(data, url) {
    return parseCommonResponse(data, url);
  }

  function extractCitationsFromData(msg) {
    const citations = [];
    const metadata = msg.metadata || msg.citations || msg.references;

    if (Array.isArray(metadata)) {
      metadata.forEach(function(cite, index) {
        citations.push({
          index: index + 1,
          url: cite.url || cite.link,
          title: cite.title || cite.name,
        });
      });
    } else if (metadata && typeof metadata === 'object') {
      Object.keys(metadata).forEach(function(key, index) {
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
  }

  function readPageState() {
    const possibleGlobals = [
      '__CHATGPT_DATA__',
      '__CLAUDE_DATA__',
      '__AI_CONVERSATION__',
      '__AI_EXPORT__',
    ];

    for (const key of possibleGlobals) {
      try {
        const obj = window[key];
        if (obj && key !== '__AI_EXPORT__') {
          console.log('[AI Export] Found data in global:', key);
          return obj;
        }
      } catch(e) {}
    }

    const scripts = document.querySelectorAll('script[id*="data"], script[class*="data"], script[type="application/json"]');
    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent);
        if (data.messages || data.conversation) {
          console.log('[AI Export] Found data in script:', script.id || script.className);
          return data;
        }
      } catch(e) {}
    }

    return null;
  }

  function onPageLoad() {
    console.log('[AI Export] Page loaded, reading initial state...');

    try {
      const pageState = readPageState();
      if (pageState) {
        const platform = getCurrentPlatform();
        const parsed = parseAIResponse('', pageState, platform);
        if (parsed && parsed.messages && parsed.messages.length > 0) {
          capturedData.messages = parsed.messages;
          capturedData.metadata = parsed.metadata || {};

          sendDataToContentScript({
            type: 'INITIAL_STATE_CAPTURED',
            messages: capturedData.messages,
            metadata: capturedData.metadata,
            platform: platform?.name,
          });
        }
      }
    } catch (error) {
      console.error('[AI Export] Failed to read page state:', error);
    }
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onPageLoad);
  } else {
    onPageLoad();
  }

  window.__AI_EXPORT__ = {
    getData: function() {
      return { ...capturedData };
    },

    exportNow: function() {
      sendDataToContentScript({
        type: 'EXPORT_REQUESTED',
        data: capturedData
      });
      return capturedData;
    },

    clearData: function() {
      capturedData = { conversations: [], messages: [], references: [], metadata: {} };
      seenMessageIds = new Set();
    },

    setNetworkInterception: function(enabled) {
      networkInterceptionEnabled = enabled;
    },

    getPlatform: getCurrentPlatform,

    getMessages: function() {
      return [...capturedData.messages];
    },
  };

  console.log('[AI Export] Injection complete, global interface exposed (v2.0)');

})(typeof window !== 'undefined' ? window : this);

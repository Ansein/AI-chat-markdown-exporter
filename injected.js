// injected.js - 页面注入脚本
// 运行在页面上下文中，负责拦截网络请求和读取页面状态

(function() {
  'use strict';

  console.log('[AI Export] Injected script initialized');

  // 存储捕获的数据
  let capturedData = {
    conversations: [],
    messages: [],
    references: [],
    metadata: {}
  };

  // 已捕获的消息 ID 去重
  let seenMessageIds = new Set();

  // 发送数据到 content script
  function sendDataToContentScript(data) {
    window.dispatchEvent(new CustomEvent('AIExportData', {
      detail: data
    }));
  }

  // ========== Fetch 拦截 ==========
  const originalFetch = window.fetch;
  window.fetch = function(...args) {
    const url = args[0]?.url || args[0];
    const options = args[1] || {};

    return originalFetch.apply(this, args).then(response => {
      const clonedResponse = response.clone();
      if (isAIRequest(url)) {
        handleAIRequest(url, options, clonedResponse).catch(function(err) {
          console.error('[AI Export] Failed to handle AI request:', err);
        });
      }
      return response;
    }).catch(function(error) {
      console.error('[AI Export] Fetch error:', error);
      throw error;
    });
  };

  // ========== XMLHttpRequest 拦截 ==========
  const originalXHROpen = XMLHttpRequest.prototype.open;
  const originalXHROpenSend = XMLHttpRequest.prototype.send;

  XMLHttpRequest.prototype.open = function(method, url, ...restArgs) {
    this._url = url;
    this._method = method;
    return originalXHROpen.apply(this, [method, url, ...restArgs]);
  };

  XMLHttpRequest.prototype.send = function(body) {
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
            json: function() { return JSON.parse(this.responseText); },
            text: function() { return this.responseText; }
          }).catch(function(err) {
            console.error('[AI Export] Failed to handle XHR:', err);
          });
        } catch (err) {
          console.warn('[AI Export] XHR response parse error:', err);
        }
      });
    }

    return originalXHROpenSend.apply(this, [body]);
  };

  // ========== URL 模式检测 ==========
  function isClaudeConversationAPI(url) {
    if (!url || typeof url !== 'string') return false;
    return /claude\.ai\/api\/organizations\/[^/]+\/chat_conversations/.test(url);
  }

  function isAIRequest(url) {
    if (!url || typeof url !== 'string') return false;
    const lower = url.toLowerCase();
    const patterns = [
      'chatgpt', 'openai', 'claude', 'anthropic',
      'conversation', 'chat/completions', '/api/chat',
      '/api/conversation', '/backend-api'
    ];
    return patterns.some(function(p) { return lower.indexOf(p) !== -1; });
  }

  // ========== 处理 AI 请求 ==========
  async function handleAIRequest(url, options, response) {
    try {
      let data;
      try {
        data = await response.json();
      } catch(e) {
        const text = await response.text();
        if (text.startsWith('{') || text.startsWith('[')) {
          data = JSON.parse(text);
        } else {
          return;
        }
      }

      console.log('[AI Export] AI response data:', Object.keys(data));

      // 解析响应数据
      const parsed = parseAIResponse(url, data);
      if (parsed && parsed.messages && parsed.messages.length > 0) {
        // 去重
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
            metadata: capturedData.metadata
          });
        }
      }
    } catch (err) {
      console.error('[AI Export] Failed to parse AI response:', err);
    }
  }

  // ========== 解析 AI 响应 ==========
  function parseAIResponse(url, data) {
    // Claude 对话树 API (优先)
    if (isClaudeConversationAPI(url) && data.children && Array.isArray(data.children)) {
      return parseClaudeConversationTree(data);
    }

    // ChatGPT 响应
    if (data.conversation || data.messages) {
      return parseChatGPTResponse(data);
    }

    // Claude 单条消息流式响应
    if (data.completion || data.content) {
      return parseClaudeResponse(data);
    }

    // 通用响应
    return parseGenericResponse(data);
  }

  // ========== ChatGPT 响应解析 ==========
  function parseChatGPTResponse(data) {
    const messages = [];
    const conversation = data.conversation || {};

    if (Array.isArray(data.messages)) {
      data.messages.forEach(function(msg) {
        if (!msg.id || !msg.author) return;
        const role = msg.author && msg.author.role ? msg.author.role : msg.role;
        const content = (msg.content && msg.content.parts) ? msg.content.parts.join('') : (msg.content && msg.content.text ? msg.content.text : '');

        messages.push({
          id: msg.id,
          role: role === 'user' ? 'user' : 'assistant',
          contentText: content,
          contentMarkdown: content,
          createdAt: msg.create_time ? new Date(msg.create_time).toISOString() : null,
          model: (msg.metadata && msg.metadata.model) ? msg.metadata.model : null,
          citations: extractCitationsFromData(msg),
        });
      });
    }

    return {
      messages: messages,
      metadata: {
        conversationId: (conversation && conversation.id) ? conversation.id : data.conversation_id,
        title: (conversation && conversation.title) ? conversation.title : null,
        model: data.model,
      }
    };
  }

  // ========== Claude 对话树解析 ==========
  function parseClaudeConversationTree(data) {
    var messages = [];

    // 递归展平消息树
    function flattenMessageTree(node) {
      if (!node) return;

      // 当前节点有 sender 和 content
      if (node.sender && node.content) {
        var role = node.sender === 'human' ? 'user' : 'assistant';
        var textContent = '';
        var reasoningText = '';
        var citations = [];
        var model = node.model;

        if (Array.isArray(node.content)) {
          for (var i = 0; i < node.content.length; i++) {
            var block = node.content[i];
            if (block.type === 'text' && block.text) {
              textContent += block.text;
            } else if (block.type === 'thinking' && block.thinking) {
              reasoningText += block.thinking;
            } else if (block.type === 'tool_use' && block.name === 'web_search') {
              // 提取 web search 的 URL
              if (block.input && block.input.query) {
                citations.push({
                  url: 'https://www.google.com/search?q=' + encodeURIComponent(block.input.query),
                  title: 'Search: ' + block.input.query
                });
              }
            } else if (block.type === 'tool_result' && block.content) {
              if (typeof block.content === 'string') {
                var urls = block.content.match(/https?:\/\/[^\s"<>]+/g);
                if (urls) {
                  urls.forEach(function(u) {
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

      // 递归子节点
      if (Array.isArray(node.children)) {
        for (var j = 0; j < node.children.length; j++) {
          flattenMessageTree(node.children[j]);
        }
      }
    }

    // 从根节点开始展平
    flattenMessageTree(data);

    return {
      messages: messages,
      metadata: {
        conversationId: data.uuid || null,
        title: data.name || null,
        model: data.model || null,
      }
    };
  }

  // ========== Claude 单条消息响应解析 ==========
  function parseClaudeResponse(data) {
    var messages = [];

    if (data.completion) {
      messages.push({
        id: data.id || ('msg-' + Date.now()),
        role: 'assistant',
        contentText: data.completion,
        contentMarkdown: data.completion,
        createdAt: data.created_at ? new Date(data.created_at).toISOString() : null,
      });
    }

    // 处理 content blocks (streaming API response)
    if (Array.isArray(data.content)) {
      for (var i = 0; i < data.content.length; i++) {
        var block = data.content[i];
        if (block.type === 'text' && block.text) {
          messages.push({
            id: data.id || ('msg-' + Date.now()),
            role: 'assistant',
            contentText: block.text,
            contentMarkdown: block.text,
          });
        } else if (block.type === 'thinking' && block.thinking) {
          // reasoning/thinking block
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
      messages: messages,
      metadata: {
        model: data.model,
      }
    };
  }

  // ========== 通用响应解析 ==========
  function parseGenericResponse(data) {
    var messages = [];
    var possibleFields = ['messages', 'conversation', 'history', 'data', 'response'];
    for (var i = 0; i < possibleFields.length; i++) {
      var field = possibleFields[i];
      if (Array.isArray(data[field])) {
        data[field].forEach(function(msg) {
          if (msg.content || msg.text || msg.message) {
            messages.push({
              id: msg.id || ('msg-' + Date.now()),
              role: msg.role || 'assistant',
              contentText: msg.content || msg.text || msg.message,
            });
          }
        });
      }
    }
    return { messages: messages };
  }

  // ========== 从数据中提取引用 ==========
  function extractCitationsFromData(msg) {
    var citations = [];
    var metadata = msg.metadata || msg.citations || msg.references;

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
        var cite = metadata[key];
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

  // ========== 读取页面状态 ==========
  function readPageState() {
    var possibleGlobals = [
      '__CHATGPT_DATA__',
      '__CLAUDE_DATA__',
      '__AI_CONVERSATION__',
    ];

    for (var i = 0; i < possibleGlobals.length; i++) {
      try {
        var obj = window[possibleGlobals[i]];
        if (obj) {
          console.log('[AI Export] Found data in:', possibleGlobals[i]);
          return obj;
        }
      } catch(e) {}
    }

    // 尝试从 script 标签读取内嵌数据
    var scripts = document.querySelectorAll('script[id*="data"], script[class*="data"], script[type="application/json"]');
    for (var j = 0; j < scripts.length; j++) {
      try {
        var data = JSON.parse(scripts[j].textContent);
        if (data.messages || data.conversation) {
          console.log('[AI Export] Found data in script:', scripts[j].id || scripts[j].className);
          return data;
        }
      } catch(e) {}
    }

    return null;
  }

  // ========== 页面加载完成后读取初始状态 ==========
  function onPageLoad() {
    console.log('[AI Export] Page loaded, reading initial state...');

    var pageState = readPageState();
    if (pageState) {
      var parsed = parseAIResponse('', pageState);
      if (parsed && parsed.messages && parsed.messages.length > 0) {
        capturedData.messages = parsed.messages;
        capturedData.metadata = parsed.metadata || {};

        sendDataToContentScript({
          type: 'INITIAL_STATE_CAPTURED',
          messages: capturedData.messages,
          metadata: capturedData.metadata
        });
      }
    }
  }

  // 等待 DOM 加载完成
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', onPageLoad);
  } else {
    onPageLoad();
  }

  // ========== 暴露全局接口 ==========
  window.__AI_EXPORT__ = {
    getData: function() { return capturedData; },
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
    }
  };

  console.log('[AI Export] Injection complete, global interface exposed');
})();

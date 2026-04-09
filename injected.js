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

    console.log('[AI Export] Fetch intercepted:', url);

    return originalFetch.apply(this, args).then(response => {
      // 克隆响应以便我们能读取 body
      const clonedResponse = response.clone();

      // 检查是否是 AI 相关的 API 请求
      if (isAIRequest(url)) {
        handleAIRequest(url, options, clonedResponse).catch(err => {
          console.error('[AI Export] Failed to handle AI request:', err);
        });
      }

      return response;
    }).catch(error => {
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
            json: () => JSON.parse(this.responseText),
            text: () => this.responseText
          }).catch(err => {
            console.error('[AI Export] Failed to handle XHR:', err);
          });
        } catch (err) {
          console.warn('[AI Export] XHR response parse error:', err);
        }
      });
    }

    return originalXHROpenSend.apply(this, [body]);
  };

  // ========== 判断是否是 AI 相关的请求 ==========
  function isAIRequest(url) {
    if (!url || typeof url !== 'string') return false;

    const aiPatterns = [
      'chatgpt',
      'openai',
      'claude',
      'anthropic',
      'conversation',
      'chat/completions',
      '/api/chat',
      '/api/conversation',
      '/backend-api',
    ];

    return aiPatterns.some(pattern => url.toLowerCase().includes(pattern));
  }

  // ========== 处理 AI 请求 ==========
  async function handleAIRequest(url, options, response) {
    try {
      let data;

      // 尝试解析 JSON
      try {
        data = await response.json();
      } catch {
        const text = await response.text();
        if (text.startsWith('{') || text.startsWith('[')) {
          data = JSON.parse(text);
        } else {
          console.log('[AI Export] Non-JSON response, skipping');
          return;
        }
      }

      console.log('[AI Export] AI response data:', Object.keys(data));

      // 解析响应数据
      const parsed = parseAIResponse(url, data);
      if (parsed?.messages?.length) {
        capturedData.messages = [...capturedData.messages, ...parsed.messages];
        capturedData.metadata = { ...capturedData.metadata, ...parsed.metadata };

        // 发送到 content script
        sendDataToContentScript({
          type: 'MESSAGES_CAPTURED',
          messages: capturedData.messages,
          metadata: capturedData.metadata
        });
      }
    } catch (err) {
      console.error('[AI Export] Failed to parse AI response:', err);
    }
  }

  // ========== 解析 AI 响应 ==========
  function parseAIResponse(url, data) {
    // ChatGPT 响应解析
    if (data.conversation || data.messages) {
      return parseChatGPTResponse(data);
    }

    // Claude 响应解析
    if (data.completion || data.content) {
      return parseClaudeResponse(data);
    }

    // 通用响应解析
    return parseGenericResponse(data);
  }

  // ========== ChatGPT 响应解析 ==========
  function parseChatGPTResponse(data) {
    const messages = [];
    const conversation = data.conversation || {};

    // 解析消息
    if (Array.isArray(data.messages)) {
      data.messages.forEach(msg => {
        if (!msg.id || !msg.author) return;

        const role = msg.author?.role || msg.role;
        const content = msg.content?.parts?.join('') || msg.content?.text || '';

        messages.push({
          id: msg.id,
          role: role === 'user' ? 'user' : 'assistant',
          contentText: content,
          contentMarkdown: content,
          createdAt: msg.create_time ? new Date(msg.create_time).toISOString() : null,
          model: msg.metadata?.model ?? null,
          citations: extractCitationsFromData(msg),
        });
      });
    }

    return {
      messages: messages,
      metadata: {
        conversationId: conversation.id || data.conversation_id,
        title: conversation.title,
        model: data.model,
      }
    };
  }

  // ========== Claude 响应解析 ==========
  function parseClaudeResponse(data) {
    const messages = [];

    // 解析完成的消息
    if (data.completion) {
      messages.push({
        id: data.id || 'msg-' + Date.now(),
        role: 'assistant',
        contentText: data.completion,
        contentMarkdown: data.completion,
      });
    }

    // 解析内容块
    if (Array.isArray(data.content)) {
      data.content.forEach(block => {
        if (block.type === 'text' && block.text) {
          messages.push({
            id: data.id || 'msg-' + Date.now(),
            role: 'assistant',
            contentText: block.text,
            contentMarkdown: block.text,
          });
        }
      });
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
    const messages = [];

    // 尝试从各种可能的字段提取消息
    const possibleFields = ['messages', 'conversation', 'history', 'data', 'response'];
    for (const field of possibleFields) {
      if (Array.isArray(data[field])) {
        data[field].forEach(msg => {
          if (msg.content || msg.text || msg.message) {
            messages.push({
              id: msg.id || 'msg-' + Date.now(),
              role: msg.role || 'assistant',
              contentText: msg.content || msg.text || msg.message,
            });
          }
        });
      }
    }

    return { messages };
  }

  // ========== 从数据中提取引用 ==========
  function extractCitationsFromData(msg) {
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
      Object.values(metadata).forEach((cite, index) => {
        if (cite.url) {
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
    console.log('[AI Export] Reading page state...');

    // 尝试从各种全局对象读取数据
    const possibleGlobals = [
      'window.__CHATGPT_DATA__',
      'window.__CLAUDE_DATA__',
      'window.__AI_CONVERSATION__',
    ];

    for (const globalPath of possibleGlobals) {
      try {
        const parts = globalPath.replace('window.', '').split('.');
        let obj = window;
        for (const part of parts) {
          obj = obj?.[part];
        }
        if (obj) {
          console.log('[AI Export] Found data in:', globalPath);
          return obj;
        }
      } catch {
        // 忽略错误
      }
    }

    // 尝试从 script 标签读取内嵌数据
    const scripts = document.querySelectorAll('script[id*="data"], script[class*="data"], script[type="application/json"]');
    for (const script of scripts) {
      try {
        const data = JSON.parse(script.textContent);
        if (data.messages || data.conversation) {
          console.log('[AI Export] Found data in script:', script.id || script.className);
          return data;
        }
      } catch {
        // 忽略
      }
    }

    return null;
  }

  // ========== 页面加载完成后读取初始状态 ==========
  function onPageLoad() {
    console.log('[AI Export] Page loaded, reading initial state...');

    const pageState = readPageState();
    if (pageState) {
      const parsed = parseAIResponse('', pageState);
      if (parsed?.messages?.length) {
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
  // 供外部脚本调用
  window.__AI_EXPORT__ = {
    getData: () => capturedData,
    exportNow: () => {
      sendDataToContentScript({
        type: 'EXPORT_REQUESTED',
        data: capturedData
      });
      return capturedData;
    },
    clearData: () => {
      capturedData = { conversations: [], messages: [], references: [], metadata: {} };
    }
  };

  console.log('[AI Export] Injection complete, global interface exposed');
})();

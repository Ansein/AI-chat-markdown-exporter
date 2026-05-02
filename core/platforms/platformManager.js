// platformManager.js - 平台管理器
// 统一管理所有AI平台的适配模块

(function(global) {
  'use strict';

  const registeredPlatforms = new Map();

  const defaultPlatformConfig = {
    name: 'unknown',
    displayName: '未知平台',
    urlPatterns: [],
    selectors: {
      messageContainer: '',
      userMessage: '',
      assistantMessage: '',
      messageContent: '',
      timestamp: '',
      modelInfo: '',
      thinking: '',
      citations: '',
    },
    apiPatterns: [],
    features: {
      networkInterception: true,
      domParsing: true,
      conversationList: false,
      dynamicContent: false,
    },
  };

  function registerPlatform(config) {
    const platformConfig = { ...defaultPlatformConfig, ...config };
    registeredPlatforms.set(config.name, platformConfig);
    console.log(`[AI Export] Platform registered: ${config.displayName}`);
    return platformConfig;
  }

  function detectPlatform(url) {
    if (!url) return null;

    for (const [name, config] of registeredPlatforms.entries()) {
      if (matchesUrlPatterns(url, config.urlPatterns)) {
        return { ...config };
      }
    }

    return null;
  }

  function matchesUrlPatterns(url, patterns) {
    if (!patterns || patterns.length === 0) return false;

    return patterns.some(pattern => {
      if (pattern instanceof RegExp) {
        return pattern.test(url);
      }
      if (typeof pattern === 'string') {
        return url.includes(pattern);
      }
      return false;
    });
  }

  function getPlatformConfig(platformName) {
    return registeredPlatforms.get(platformName) || null;
  }

  function getAllPlatforms() {
    return Array.from(registeredPlatforms.entries()).map(([name, config]) => ({
      name,
      displayName: config.displayName,
      urlPatterns: config.urlPatterns,
      features: config.features,
    }));
  }

  const PlatformManager = {
    register: registerPlatform,
    detect: detectPlatform,
    getConfig: getPlatformConfig,
    getAll: getAllPlatforms,
    has: (name) => registeredPlatforms.has(name),
  };

  global.PlatformManager = PlatformManager;

  console.log('[AI Export] PlatformManager initialized');

})(typeof window !== 'undefined' ? window : this);

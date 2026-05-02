// cacheManager.js - 缓存管理器
// 负责历史会话的本地缓存、检索和管理

(function(global) {
  'use strict';

  const STORAGE_KEYS = {
    CONVERSATIONS: 'ai_export_conversations',
    SETTINGS: 'ai_export_settings',
    METADATA: 'ai_export_metadata',
  };

  const DEFAULT_CACHE_CONFIG = {
    maxConversations: 500,
    maxAgeDays: 30,
    autoCleanup: true,
  };

  let cacheConfig = { ...DEFAULT_CACHE_CONFIG };

  async function getStorage() {
    if (typeof chrome !== 'undefined' && chrome.storage) {
      return chrome.storage.local;
    }
    return localStorage;
  }

  async function getFromStorage(key) {
    const storage = await getStorage();

    if (typeof chrome !== 'undefined' && chrome.storage) {
      return new Promise((resolve) => {
        storage.get([key], (result) => {
          resolve(result[key] || null);
        });
      });
    }

    try {
      const data = storage.getItem(key);
      return data ? JSON.parse(data) : null;
    } catch (e) {
      console.error('[AI Export] Storage read error:', e);
      return null;
    }
  }

  async function saveToStorage(key, data) {
    const storage = await getStorage();

    if (typeof chrome !== 'undefined' && chrome.storage) {
      return new Promise((resolve) => {
        storage.set({ [key]: data }, () => {
          resolve(true);
        });
      });
    }

    try {
      storage.setItem(key, JSON.stringify(data));
      return true;
    } catch (e) {
      console.error('[AI Export] Storage save error:', e);
      return false;
    }
  }

  async function removeFromStorage(key) {
    const storage = await getStorage();

    if (typeof chrome !== 'undefined' && chrome.storage) {
      return new Promise((resolve) => {
        storage.remove([key], () => {
          resolve(true);
        });
      });
    }

    storage.removeItem(key);
    return true;
  }

  async function getAllConversations() {
    const data = await getFromStorage(STORAGE_KEYS.CONVERSATIONS);
    return data || [];
  }

  async function getConversationById(id) {
    const conversations = await getAllConversations();
    return conversations.find(c => c.id === id) || null;
  }

  async function getConversationsByPlatform(platform) {
    const conversations = await getAllConversations();
    return conversations.filter(c => c.platform === platform);
  }

  async function saveConversation(conversation) {
    if (!conversation || !conversation.id) {
      throw new Error('Conversation must have an id');
    }

    const conversations = await getAllConversations();

    const existingIndex = conversations.findIndex(c => c.id === conversation.id);

    const conversationToSave = {
      ...conversation,
      updatedAt: new Date().toISOString(),
      createdAt: conversation.createdAt || new Date().toISOString(),
    };

    if (existingIndex >= 0) {
      conversations[existingIndex] = conversationToSave;
    } else {
      conversations.unshift(conversationToSave);
    }

    if (cacheConfig.autoCleanup) {
      await cleanupOldConversations(conversations);
    }

    await saveToStorage(STORAGE_KEYS.CONVERSATIONS, conversations);
    return conversationToSave;
  }

  async function saveBatchConversations(conversationList) {
    if (!Array.isArray(conversationList)) {
      throw new Error('Expected array of conversations');
    }

    const conversations = await getAllConversations();
    const existingIds = new Set(conversations.map(c => c.id));
    const now = new Date().toISOString();

    conversationList.forEach(conv => {
      if (!conv.id) return;

      const conversationToSave = {
        ...conv,
        updatedAt: now,
        createdAt: conv.createdAt || now,
      };

      if (existingIds.has(conv.id)) {
        const index = conversations.findIndex(c => c.id === conv.id);
        if (index >= 0) {
          conversations[index] = conversationToSave;
        }
      } else {
        conversations.unshift(conversationToSave);
        existingIds.add(conv.id);
      }
    });

    if (cacheConfig.autoCleanup) {
      await cleanupOldConversations(conversations);
    }

    await saveToStorage(STORAGE_KEYS.CONVERSATIONS, conversations);
    return conversations;
  }

  async function deleteConversation(id) {
    const conversations = await getAllConversations();
    const filtered = conversations.filter(c => c.id !== id);

    if (filtered.length === conversations.length) {
      return false;
    }

    await saveToStorage(STORAGE_KEYS.CONVERSATIONS, filtered);
    return true;
  }

  async function deleteConversations(ids) {
    if (!Array.isArray(ids)) {
      throw new Error('Expected array of ids');
    }

    const conversations = await getAllConversations();
    const idSet = new Set(ids);
    const filtered = conversations.filter(c => !idSet.has(c.id));

    await saveToStorage(STORAGE_KEYS.CONVERSATIONS, filtered);
    return conversations.length - filtered.length;
  }

  async function clearAllConversations() {
    await removeFromStorage(STORAGE_KEYS.CONVERSATIONS);
    return true;
  }

  async function cleanupOldConversations(conversations) {
    const maxAgeMs = cacheConfig.maxAgeDays * 24 * 60 * 60 * 1000;
    const now = Date.now();

    let filtered = conversations;

    if (cacheConfig.maxConversations > 0 && conversations.length > cacheConfig.maxConversations) {
      filtered = filtered.slice(0, cacheConfig.maxConversations);
    }

    if (cacheConfig.maxAgeDays > 0) {
      filtered = filtered.filter(c => {
        if (!c.createdAt && !c.updatedAt) return true;
        const dateStr = c.updatedAt || c.createdAt;
        try {
          const date = new Date(dateStr);
          return now - date.getTime() <= maxAgeMs;
        } catch (e) {
          return true;
        }
      });
    }

    return filtered;
  }

  async function searchConversations(query, options = {}) {
    const conversations = await getAllConversations();

    const {
      platform = null,
      startDate = null,
      endDate = null,
      limit = 100,
      offset = 0,
    } = options;

    const lowerQuery = query ? query.toLowerCase() : '';

    let results = conversations.filter(conv => {
      if (platform && conv.platform !== platform) {
        return false;
      }

      if (startDate || endDate) {
        const convDate = new Date(conv.createdAt || conv.updatedAt || 0);
        if (startDate && convDate < new Date(startDate)) return false;
        if (endDate && convDate > new Date(endDate)) return false;
      }

      if (lowerQuery) {
        const searchText = [
          conv.title,
          conv.platform,
          ...(conv.messages?.map(m => m.contentText || m.contentMarkdown || '') || []),
        ].join(' ').toLowerCase();

        if (!searchText.includes(lowerQuery)) {
          return false;
        }
      }

      return true;
    });

    const total = results.length;
    results = results.slice(offset, offset + limit);

    return {
      results,
      total,
      offset,
      limit,
      hasMore: offset + limit < total,
    };
  }

  async function getSettings() {
    const settings = await getFromStorage(STORAGE_KEYS.SETTINGS);
    return {
      ...getDefaultSettings(),
      ...settings,
    };
  }

  function getDefaultSettings() {
    return {
      includeTimestamp: true,
      includeModelInfo: true,
      includeReferences: true,
      includeReasoningSummary: true,
      format: 'markdown',
      filenameTemplate: '{title}_{timestamp}.md',
      dateFormat: 'YYYY-MM-DD HH:mm:ss',
      cacheConfig: { ...DEFAULT_CACHE_CONFIG },
    };
  }

  async function saveSettings(settings) {
    const existing = await getSettings();
    const merged = { ...existing, ...settings };

    if (merged.cacheConfig) {
      cacheConfig = { ...cacheConfig, ...merged.cacheConfig };
    }

    await saveToStorage(STORAGE_KEYS.SETTINGS, merged);
    return merged;
  }

  async function getStatistics() {
    const conversations = await getAllConversations();

    const platformStats = {};
    let totalMessages = 0;
    let latestDate = null;
    let earliestDate = null;

    conversations.forEach(conv => {
      platformStats[conv.platform] = (platformStats[conv.platform] || 0) + 1;

      if (conv.messages) {
        totalMessages += conv.messages.length;
      }

      const convDate = new Date(conv.createdAt || conv.updatedAt || 0);
      if (!latestDate || convDate > latestDate) latestDate = convDate;
      if (!earliestDate || convDate < earliestDate) earliestDate = convDate;
    });

    return {
      totalConversations: conversations.length,
      totalMessages,
      platformStats,
      latestDate: latestDate?.toISOString() || null,
      earliestDate: earliestDate?.toISOString() || null,
      cacheConfig: { ...cacheConfig },
    };
  }

  async function exportAllData() {
    const conversations = await getAllConversations();
    const settings = await getSettings();

    return {
      version: '1.0',
      exportedAt: new Date().toISOString(),
      conversations,
      settings,
    };
  }

  async function importAllData(data, merge = true) {
    if (!data || !data.conversations) {
      throw new Error('Invalid import data');
    }

    if (merge) {
      const existing = await getAllConversations();
      const existingIds = new Set(existing.map(c => c.id));

      const merged = [...existing];
      data.conversations.forEach(conv => {
        if (!existingIds.has(conv.id)) {
          merged.push(conv);
        }
      });

      await saveToStorage(STORAGE_KEYS.CONVERSATIONS, merged);
    } else {
      await saveToStorage(STORAGE_KEYS.CONVERSATIONS, data.conversations);
    }

    if (data.settings) {
      await saveSettings(data.settings);
    }

    return {
      imported: data.conversations.length,
      merged: merge,
    };
  }

  const CacheManager = {
    // Conversations
    getAllConversations,
    getConversationById,
    getConversationsByPlatform,
    saveConversation,
    saveBatchConversations,
    deleteConversation,
    deleteConversations,
    clearAllConversations,

    // Search
    searchConversations,

    // Settings
    getSettings,
    getDefaultSettings,
    saveSettings,

    // Statistics
    getStatistics,

    // Import/Export
    exportAllData,
    importAllData,

    // Storage
    getFromStorage,
    saveToStorage,

    // Config
    getCacheConfig: () => ({ ...cacheConfig }),
    setCacheConfig: (config) => {
      cacheConfig = { ...cacheConfig, ...config };
    },
  };

  global.CacheManager = CacheManager;

  console.log('[AI Export] CacheManager initialized');

})(typeof window !== 'undefined' ? window : this);

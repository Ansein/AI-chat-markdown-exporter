// htmlToMarkdown.js - HTML 转 Markdown 工具
// 增强版，支持更多富文本格式和公式渲染

(function(global) {
  'use strict';

  const config = {
    preserveWhitespace: false,
    convertImages: true,
    convertTables: true,
    convertMath: true,
    stripComments: true,
  };

  function decodeHtml(html) {
    if (!html) return '';
    const txt = document.createElement('textarea');
    txt.innerHTML = html;
    return txt.value;
  }

  function stripTags(html) {
    return html.replace(/<[^>]+>/g, '');
  }

  function normalizeWhitespace(text) {
    return text
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .replace(/\s+([,.;:!?])/g, '$1')
      .trim();
  }

  function normalizeMarkdown(text) {
    return text
      .replace(/\r/g, '')
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{4,}/g, '\n\n\n')
      .trim();
  }

  function hasBlockChildren(el) {
    if (!el || !el.children) return false;
    return Array.from(el.children).some(child => {
      const tag = child.tagName?.toLowerCase();
      return /^(div|section|article|main|p|pre|blockquote|ul|ol|table|h[1-6]|hr)$/i.test(tag);
    });
  }

  function extractMathFromElement(el, inlineContext = false) {
    if (!el) return null;

    const tag = el.tagName?.toLowerCase() || '';
    const className = typeof el.className === 'string' ? el.className : '';
    const classList = el.classList || [];

    if (tag === 'annotation' || tag === 'annotation-xml' || tag === 'semantics') {
      return '';
    }

    if (/(katex-html|mjx-assistive-mml|MathJax_Preview)/i.test(className)) {
      return '';
    }

    const isMathContainer =
      tag === 'math' ||
      tag === 'mjx-container' ||
      /(?:^|\s)(katex|katex-display|katex-mathml|math-display|math-inline)(?:\s|$)/i.test(className) ||
      /(mjx|mathjax)/i.test(className) ||
      (classList.contains && (
        classList.contains('katex') ||
        classList.contains('katex-display') ||
        classList.contains('math') ||
        classList.contains('math-display')
      )) ||
      el.hasAttribute?.('data-tex');

    if (!isMathContainer) {
      return null;
    }

    let latex =
      el.getAttribute?.('data-tex') ||
      el.getAttribute?.('data-latex') ||
      el.getAttribute?.('aria-label') ||
      '';

    if (!latex) {
      const annotationSelectors = [
        'annotation[encoding="application/x-tex"]',
        'annotation[encoding="application/x-latex"]',
        'annotation[encoding*="tex" i]',
        'annotation[encoding*="latex" i]',
        'script[type^="math/tex"]',
        'annotation',
      ];

      for (const selector of annotationSelectors) {
        const node = el.querySelector?.(selector);
        if (node?.textContent) {
          latex = node.textContent;
          break;
        }
      }
    }

    const cleanLatex = latex?.replace(/\s+/g, ' ').trim() || '';

    if (!cleanLatex) {
      const fallbackText = getVisibleText(el);
      if (!fallbackText) return '';
      return inlineContext ? `$${fallbackText}$` : `\n$$\n${fallbackText}\n$$\n\n`;
    }

    const isBlockMath =
      !inlineContext ||
      tag === 'mjx-container' ||
      (classList.contains && (
        classList.contains('katex-display') ||
        classList.contains('math-display')
      )) ||
      /display/i.test(className) ||
      getVisibleText(el).includes('\n');

    if (isBlockMath) {
      return `\n$$\n${cleanLatex}\n$$\n\n`;
    }

    return `$${cleanLatex}$`;
  }

  function getVisibleText(el) {
    if (!el) return '';
    const text = typeof el.innerText === 'string' ? el.innerText : (el.textContent || '');
    return text.replace(/\u00a0/g, ' ');
  }

  function serializePreformattedText(root) {
    if (!root) return '';

    const parts = [];

    function walk(node) {
      if (!node) return;

      if (node.nodeType === Node.TEXT_NODE) {
        parts.push(node.textContent || '');
        return;
      }

      if (node.nodeType !== Node.ELEMENT_NODE) {
        return;
      }

      const el = node;
      const tag = el.tagName?.toLowerCase() || '';

      if (tag === 'br') {
        parts.push('\n');
        return;
      }

      const children = Array.from(el.childNodes || []);
      children.forEach((child, index) => {
        walk(child);

        if (child.nodeType === Node.ELEMENT_NODE) {
          const childEl = child;
          const childTag = childEl.tagName?.toLowerCase() || '';
          const childClass = childEl.className || '';
          const shouldBreakLine =
            /^(div|p|li|tr)$/.test(childTag) ||
            /(line|code-line)/i.test(childClass) ||
            childEl.getAttribute?.('data-line') !== null;

          if (shouldBreakLine && index < children.length - 1) {
            if (!parts[parts.length - 1]?.endsWith('\n')) {
              parts.push('\n');
            }
          }
        }
      });
    }

    walk(root);

    return parts.join('')
      .replace(/\u00a0/g, ' ')
      .replace(/\n{3,}/g, '\n\n');
  }

  function serializeTable(tableEl) {
    if (!tableEl) return '';

    const rows = Array.from(tableEl.querySelectorAll('tr') || []);
    if (!rows.length) return '';

    let markdown = '\n';

    rows.forEach((tr, rowIndex) => {
      const cells = Array.from(tr.querySelectorAll('th, td') || []).map(cell => {
        const text = normalizeWhitespace(getVisibleText(cell)).replace(/\|/g, '\\|');
        return text || ' ';
      });

      markdown += `| ${cells.join(' | ')} |\n`;

      if (rowIndex === 0) {
        markdown += `| ${cells.map(() => '---').join(' | ')} |\n`;
      }
    });

    return `${markdown}\n`;
  }

  function serializeList(listEl, ordered, indent = 0) {
    if (!listEl) return '';

    const items = Array.from(listEl.children || []).filter(child => 
      child.tagName?.toLowerCase() === 'li'
    );

    if (!items.length) return '';

    let result = '';

    items.forEach((li, index) => {
      const marker = ordered ? `${index + 1}.` : '-';
      result += serializeListItem(li, marker, indent);
    });

    return `${result}\n`;
  }

  function serializeListItem(li, marker, indent = 0) {
    if (!li) return '';

    let inlineParts = '';
    let nestedParts = '';

    const childNodes = Array.from(li.childNodes || []);

    childNodes.forEach(child => {
      if (child.nodeType === Node.ELEMENT_NODE) {
        const tag = child.tagName?.toLowerCase() || '';

        if (tag === 'ul' || tag === 'ol') {
          nestedParts += serializeList(child, tag === 'ol', indent + 1);
          return;
        }

        if (tag === 'p') {
          const text = serializeInlineChildren(child, indent).trim();
          if (text) inlineParts += (inlineParts ? ' ' : '') + text;
          return;
        }

        if (tag === 'pre') {
          nestedParts += serializeNode(child, indent + 1, false);
          return;
        }
      }

      const fragment = serializeNode(child, indent + 1, true).trim();
      if (fragment) {
        inlineParts += (inlineParts ? ' ' : '') + fragment;
      }
    });

    const indentStr = '  '.repeat(indent);
    let result = '';

    if (inlineParts) {
      result += `${indentStr}${marker} ${inlineParts}\n`;
    }

    if (nestedParts) {
      result += nestedParts;
    }

    return result;
  }

  function serializeNode(node, indent = 0, inlineContext = false) {
    if (!node) return '';

    if (node.nodeType === Node.TEXT_NODE) {
      return inlineContext ? normalizeWhitespace(node.textContent || '') : (node.textContent || '');
    }

    if (node.nodeType !== Node.ELEMENT_NODE) {
      return '';
    }

    const el = node;
    const tag = el.tagName?.toLowerCase() || '';

    if (config.convertMath) {
      const mathMarkdown = extractMathFromElement(el, inlineContext);
      if (mathMarkdown !== null) {
        return mathMarkdown;
      }
    }

    switch (tag) {
      case 'br':
        return inlineContext ? ' ' : '  \n';

      case 'pre': {
        const codeEl = el.querySelector('code');
        const langClass = codeEl?.className || '';
        const match = langClass.match(/language-([\w-]+)/);
        const lang = match ? match[1] : '';
        const codeText = serializePreformattedText(codeEl || el).replace(/\r/g, '').trimEnd();
        return `\n\`\`\`${lang}\n${codeText}\n\`\`\`\n\n`;
      }

      case 'code':
        return `\`${normalizeWhitespace(getVisibleText(el))}\``;

      case 'strong':
      case 'b':
        return `**${serializeInlineChildren(el, indent)}**`;

      case 'em':
      case 'i':
        return `*${serializeInlineChildren(el, indent)}*`;

      case 'a': {
        const href = el.getAttribute('href') || '';
        const text = normalizeWhitespace(getVisibleText(el)) || href;
        if (!href || href.startsWith('#') || href.startsWith('javascript:')) {
          return text;
        }
        return `[${text}](${href})`;
      }

      case 'h1':
      case 'h2':
      case 'h3':
      case 'h4':
      case 'h5':
      case 'h6': {
        const level = Number(tag[1]);
        const title = serializeInlineChildren(el, indent);
        return `\n${'#'.repeat(level)} ${title}\n\n`;
      }

      case 'p': {
        const text = serializeInlineChildren(el, indent);
        return text ? `${text}\n\n` : '';
      }

      case 'blockquote': {
        const text = normalizeMarkdown(serializeBlockChildren(el, indent).trim());
        if (!text) return '';
        const quoted = text.split('\n').map(line => line ? `> ${line}` : '>').join('\n');
        return `${quoted}\n\n`;
      }

      case 'ul':
        return serializeList(el, false, indent);

      case 'ol':
        return serializeList(el, true, indent);

      case 'table':
        return config.convertTables ? serializeTable(el) : '';

      case 'hr':
        return `\n---\n\n`;

      case 'img': {
        if (!config.convertImages) return '';
        const src = el.getAttribute('src') || '';
        const alt = el.getAttribute('alt') || '';
        const title = el.getAttribute('title') || '';
        if (!src) return '';
        return title ? `![${alt}](${src} "${title}")` : `![${alt}](${src})`;
      }

      case 'div':
      case 'section':
      case 'article':
      case 'main': {
        if (hasBlockChildren(el)) {
          return serializeBlockChildren(el, indent);
        }
        const text = serializeInlineChildren(el, indent);
        return text ? `${text}\n\n` : '';
      }

      case 'span':
        return serializeInlineChildren(el, indent);

      default: {
        if (hasBlockChildren(el)) {
          return serializeBlockChildren(el, indent);
        }
        return serializeInlineChildren(el, indent);
      }
    }
  }

  function serializeBlockChildren(root, indent = 0) {
    if (!root) return '';

    let result = '';
    const childNodes = Array.from(root.childNodes || []);

    childNodes.forEach(node => {
      result += serializeNode(node, indent, false);
    });

    return result;
  }

  function serializeInlineChildren(root, indent = 0) {
    if (!root) return '';

    let result = '';
    const childNodes = Array.from(root.childNodes || []);

    childNodes.forEach(node => {
      result += serializeNode(node, indent, true);
    });

    return normalizeWhitespace(result);
  }

  function htmlToMarkdown(html, options = {}) {
    if (!html) return '';

    const opts = { ...config, ...options };

    const temp = document.createElement('div');
    temp.innerHTML = html;

    temp.querySelectorAll('button, svg, style, script, noscript, .sr-only, .screen-reader-only, [aria-hidden="true"]').forEach(el => {
      el.remove?.();
    });

    if (opts.stripComments) {
      const comments = [];
      const walker = document.createTreeWalker(temp, NodeFilter.SHOW_COMMENT, null, false);
      while (walker.nextNode()) {
        comments.push(walker.currentNode);
      }
      comments.forEach(comment => comment.parentNode?.removeChild(comment));
    }

    const markdown = serializeBlockChildren(temp).trim();
    return normalizeMarkdown(markdown);
  }

  function extractCodeBlocks(html) {
    if (!html) return [];

    const blocks = [];
    const temp = document.createElement('div');
    temp.innerHTML = html;

    temp.querySelectorAll('pre').forEach((pre, index) => {
      const codeEl = pre.querySelector('code');
      const langClass = codeEl?.className || '';
      const match = langClass.match(/language-([\w-]+)/);
      const lang = match ? match[1] : '';

      blocks.push({
        index: index + 1,
        language: lang || 'text',
        code: serializePreformattedText(codeEl || pre),
      });
    });

    return blocks;
  }

  function extractReferences(html) {
    if (!html) return [];

    const refs = [];
    const temp = document.createElement('div');
    temp.innerHTML = html;

    const selectors = [
      '[class*="citation"]',
      '[class*="reference"]',
      'a[href^="http"]',
      '[data-reference]',
      '[data-citation]',
    ];

    const seenUrls = new Set();

    selectors.forEach(selector => {
      temp.querySelectorAll(selector).forEach((el, index) => {
        const url = el.getAttribute('href') || el.getAttribute('data-url') || '';
        const title = el.getAttribute('title') || el.textContent?.slice(0, 100) || '';

        if (url && url.startsWith('http') && !seenUrls.has(url)) {
          seenUrls.add(url);
          refs.push({
            index: refs.length + 1,
            url: url,
            title: title.trim() || url,
          });
        }
      });
    });

    return refs;
  }

  const HtmlToMarkdown = {
    convert: htmlToMarkdown,
    decodeHtml,
    stripTags,
    normalizeWhitespace,
    normalizeMarkdown,
    extractCodeBlocks,
    extractReferences,
    extractMath: extractMathFromElement,
    config,
  };

  global.HtmlToMarkdown = HtmlToMarkdown;

  console.log('[AI Export] HtmlToMarkdown initialized');

})(typeof window !== 'undefined' ? window : this);

// html-to-markdown.js - HTML 转 Markdown 工具
// 提供更强大的转换功能，支持代码块、表格、数学公式等

export function htmlToMarkdown(html) {
  if (!html) return '';

  const temp = document.createElement('div');
  temp.innerHTML = html;

  // 1. 处理代码块（优先处理，避免内容被转义）
  temp.querySelectorAll('pre').forEach(pre => {
    const code = pre.querySelector('code');
    let codeText = code ? code.textContent : pre.textContent;

    // 去除首尾空行
    codeText = codeText.trim();

    // 提取语言
    let lang = '';
    const langClass = code?.className || '';
    const match = langClass.match(/language-(\w+)/);
    if (match) {
      lang = match[1];
    }

    pre.outerHTML = `\n\`\`\`${lang}\n${codeText}\n\`\`\`\n`;
  });

  // 2. 处理行内代码
  temp.querySelectorAll('code:not(pre code)').forEach(code => {
    const text = code.textContent;
    if (text.length > 0) {
      code.outerHTML = `\`${text}\``;
    }
  });

  // 3. 处理数学公式
  temp.querySelectorAll('.math, .katex, mjx-container').forEach(math => {
    const tex = math.getAttribute('data-tex') || math.textContent;
    if (math.tagName.toLowerCase() === 'mjx-container' || math.classList.contains('math-display')) {
      math.outerHTML = `\n$$${tex}$$\n`;
    } else {
      math.outerHTML = `$${tex}$`;
    }
  });

  // 4. 处理标题
  ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'].forEach((tag, i) => {
    temp.querySelectorAll(tag).forEach(el => {
      const prefix = '#'.repeat(i + 1);
      el.outerHTML = `\n${prefix} ${el.textContent.trim()}\n\n`;
    });
  });

  // 5. 处理粗体和斜体
  temp.querySelectorAll('strong, b').forEach(el => {
    el.outerHTML = `**${el.textContent}**`;
  });
  temp.querySelectorAll('em, i').forEach(el => {
    const text = el.textContent;
    // 避免与行内代码冲突
    if (!text.startsWith('`')) {
      el.outerHTML = `*${text}*`;
    }
  });

  // 6. 处理删除线
  temp.querySelectorAll('del, s').forEach(el => {
    el.outerHTML = `~~${el.textContent}~~`;
  });

  // 7. 处理链接
  const references = [];
  let refIndex = 1;

  temp.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href');
    const text = a.textContent.trim();

    if (!href || href.startsWith('#') || href.startsWith('javascript:')) {
      // 无效链接，只保留文本
      a.outerHTML = text;
    } else {
      // 有效链接，转为 Markdown 格式
      a.outerHTML = `[${text}](${href})`;

      // 记录引用
      references.push({
        index: refIndex++,
        text: text,
        url: href,
        title: a.getAttribute('title') || ''
      });
    }
  });

  // 8. 处理图片
  temp.querySelectorAll('img').forEach(img => {
    const alt = img.getAttribute('alt') || '';
    const src = img.getAttribute('src') || '';
    if (src) {
      img.outerHTML = `![${alt}](${src})`;
    } else {
      img.remove();
    }
  });

  // 9. 处理段落
  temp.querySelectorAll('p').forEach(p => {
    const text = p.textContent.trim();
    if (text) {
      p.outerHTML = `${text}\n\n`;
    } else {
      p.remove();
    }
  });

  // 10. 处理换行
  temp.querySelectorAll('br').forEach(br => {
    br.outerHTML = '  \n';
  });

  // 11. 处理列表
  temp.querySelectorAll('ul').forEach(ul => {
    const items = Array.from(ul.querySelectorAll(':scope > li'))
      .map(li => `- ${li.textContent.trim()}`)
      .join('\n');
    ul.outerHTML = `\n${items}\n\n`;
  });

  temp.querySelectorAll('ol').forEach(ol => {
    const items = Array.from(ol.querySelectorAll(':scope > li'))
      .map((li, i) => `${i + 1}. ${li.textContent.trim()}`)
      .join('\n');
    ol.outerHTML = `\n${items}\n\n`;
  });

  // 12. 处理列表项（嵌套列表）
  temp.querySelectorAll('li').forEach(li => {
    // 如果 li 包含嵌套列表，保持原样（已经被上面处理）
    if (li.querySelector('ul, ol')) {
      return;
    }
    // 否则转为纯文本
    li.outerHTML = `- ${li.textContent.trim()}\n`;
  });

  // 13. 处理引用块
  temp.querySelectorAll('blockquote').forEach(bq => {
    const text = bq.textContent.trim();
    const lines = text.split('\n').map(line => `> ${line}`);
    bq.outerHTML = `\n${lines.join('\n')}\n\n`;
  });

  // 14. 处理表格
  temp.querySelectorAll('table').forEach(table => {
    const rows = table.querySelectorAll('tr');
    let mdTable = '\n';

    rows.forEach((tr, rowIndex) => {
      const cells = tr.querySelectorAll('th, td');
      const cellsText = Array.from(cells).map(cell => {
        let text = cell.textContent.trim().replace(/\|/g, '\\|');
        return text || ' ';
      });

      mdTable += `| ${cellsText.join(' | ')} |\n`;

      // 添加分隔行（在第一行之后）
      if (rowIndex === 0) {
        mdTable += `| ${cellsText.map(() => '---').join(' | ')} |\n`;
      }
    });

    table.outerHTML = mdTable + '\n';
  });

  // 15. 处理水平线
  temp.querySelectorAll('hr').forEach(hr => {
    hr.outerHTML = '\n---\n';
  });

  // 16. 处理引用脚注
  temp.querySelectorAll('sup[id^="fnref"], .footnote-ref').forEach(sup => {
    const id = sup.getAttribute('id') || '';
    const text = sup.textContent;
    sup.outerHTML = `[^${text || id}]`;
  });

  // 17. 处理可能的 UI 杂质（按钮、图标等）
  temp.querySelectorAll('[class*="btn"], [class*="button"], [class*="icon"], [aria-label="copy"], [role="button"]').forEach(el => {
    // 如果元素只有图标没有文本，直接移除
    if (!el.textContent.trim()) {
      el.remove();
    }
  });

  // 18. 清理空白节点
  const result = temp.textContent || temp.innerText || '';

  // 19. 清理多余空行
  let markdown = result
    .replace(/\n{4,}/g, '\n\n\n') // 多于 3 个空行变 2 个
    .replace(/\n\s*\n/g, '\n\n')  // 清理只包含空白的行
    .trim();

  // 20. 添加参考文献（如果有）
  if (references.length > 0) {
    markdown += '\n\n---\n\n## 参考文献\n\n';
    references.forEach(ref => {
      markdown += `[^${ref.index}] [${ref.text}](${ref.url}`;
      if (ref.title) {
        markdown += ` "${ref.title}"`;
      }
      markdown += ')\n';
    });
  }

  return markdown;
}

// 简化版本（用于快速转换）
export function htmlToMarkdownSimple(html) {
  if (!html) return '';

  const temp = document.createElement('div');
  temp.innerHTML = html;

  // 只处理最基本的格式
  temp.querySelectorAll('pre').forEach(pre => {
    pre.outerHTML = `\n\`\`\`\n${pre.textContent}\n\`\`\`\n`;
  });
  temp.querySelectorAll('strong, b').forEach(el => {
    el.outerHTML = `**${el.textContent}**`;
  });
  temp.querySelectorAll('em, i').forEach(el => {
    el.outerHTML = `*${el.textContent}*`;
  });
  temp.querySelectorAll('a[href]').forEach(a => {
    const href = a.getAttribute('href');
    if (href && !href.startsWith('#')) {
      a.outerHTML = `[${a.textContent}](${href})`;
    }
  });

  return (temp.textContent || temp.innerText || '').trim();
}

// 提取引用列表
export function extractReferences(html) {
  const references = [];
  const temp = document.createElement('div');
  temp.innerHTML = html;

  temp.querySelectorAll('a[href]').forEach((a, index) => {
    const href = a.getAttribute('href');
    if (href && href.startsWith('http')) {
      references.push({
        index: index + 1,
        url: href,
        text: a.textContent.trim(),
        title: a.getAttribute('title') || null
      });
    }
  });

  return references;
}

// 提取代码块
export function extractCodeBlocks(html) {
  const codeBlocks = [];
  const temp = document.createElement('div');
  temp.innerHTML = html;

  temp.querySelectorAll('pre').forEach(pre => {
    const code = pre.querySelector('code');
    let lang = '';

    if (code) {
      const match = code.className?.match(/language-(\w+)/);
      if (match) lang = match[1];
    }

    codeBlocks.push({
      language: lang,
      code: code ? code.textContent : pre.textContent
    });
  });

  return codeBlocks;
}

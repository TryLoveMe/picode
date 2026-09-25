// PiCode — markdown rendering (marked + highlight.js, sanitized with DOMPurify).
import { marked } from 'marked';
import hljs from 'highlight.js/lib/common';
import DOMPurify from 'dompurify';

marked.setOptions({ gfm: true, breaks: false });

function highlight(code: string, lang: string): string {
  try {
    if (lang && hljs.getLanguage(lang)) {
      return hljs.highlight(code, { language: lang, ignoreIllegals: true }).value;
    }
    const auto = hljs.highlightAuto(code);
    return auto.value;
  } catch {
    return escapeHtml(code);
  }
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

const renderer = new marked.Renderer();
renderer.code = ({ text, lang }: any) => {
  const language = (lang || '').trim().split(/\s+/)[0] || '';
  const body = highlight(text, language);
  const label = language || 'text';
  return `<div class="code-block"><div class="code-head"><span class="code-lang">${escapeHtml(label)}</span><button class="code-copy" type="button" data-code="${escapeHtml(text)}">复制</button></div><pre><code class="hljs language-${escapeHtml(label)}">${body}</code></pre></div>`;
};
renderer.link = ({ href, title, tokens }: any) => {
  const text = (tokens && tokens.map ? tokens.map((t: any) => t.raw || '').join('') : href) || href;
  return `<a href="${escapeHtml(href || '')}" title="${escapeHtml(title || '')}" target="_blank" rel="noopener noreferrer">${text}</a>`;
};

export function renderMarkdown(src: string): string {
  const html = marked.parse(src || '', { async: false, renderer }) as string;
  return DOMPurify.sanitize(html, {
    ADD_ATTR: ['target', 'rel'],
    FORBID_TAGS: ['style', 'form'],
  });
}

export function renderInlineMarkdown(src: string): string {
  const html = marked.parseInline(src || '', { renderer }) as string;
  return DOMPurify.sanitize(html, { ADD_ATTR: ['target', 'rel'] });
}

export function escapeText(s: string): string {
  return escapeHtml(s ?? '');
}

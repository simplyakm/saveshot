import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  formatVersionName,
  formatVersionTooltip,
  SITE_COPY,
} from '../content-source/site-copy.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootDir = path.resolve(__dirname, '..');

function escapeHtml(raw) {
  return String(raw)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function replacePlaceholders(text, mode) {
  const isHtml = mode === 'html';
  return String(text).replace(
    /\{\{PRIVACY_LINK\}\}/g,
    isHtml ? 'privacy.html' : 'PRIVACY.md'
  );
}

/**
 * Convert simple inline Markdown (**bold**, `code`, [label](url)) into escaped HTML.
 */
export function inlineMarkdownToHtml(rawText) {
  const tokenPattern = /(\*\*([^*]+)\*\*|`([^`]+)`|\[([^\]]+)\]\(([^)]+)\))/g;
  let result = '';
  let lastIndex = 0;

  for (const match of String(rawText).matchAll(tokenPattern)) {
    result += escapeHtml(rawText.slice(lastIndex, match.index));
    if (match[2] !== undefined) {
      result += `<strong>${escapeHtml(match[2])}</strong>`;
    } else if (match[3] !== undefined) {
      result += `<code>${escapeHtml(match[3])}</code>`;
    } else if (match[4] !== undefined && match[5] !== undefined) {
      const href = match[5];
      const external = /^https?:\/\//i.test(href);
      const extAttrs = external ? ' target="_blank" rel="noopener noreferrer"' : '';
      result += `<a href="${escapeHtml(href)}"${extAttrs}>${escapeHtml(match[4])}</a>`;
    }
    lastIndex = match.index + match[0].length;
  }

  result += escapeHtml(rawText.slice(lastIndex));
  return result;
}

export function stripInlineMarkdown(rawText) {
  return String(rawText)
    .replace(/\*\*([^*]+)\*\*/g, '$1')
    .replace(/`([^`]+)`/g, '$1')
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, '$1');
}

const MONTH_INDEX_BY_NAME = Object.freeze({
  january: '01',
  february: '02',
  march: '03',
  april: '04',
  may: '05',
  june: '06',
  july: '07',
  august: '08',
  september: '09',
  october: '10',
  november: '11',
  december: '12',
});

export function toIsoDate(rawDate) {
  const match = String(rawDate || '')
    .trim()
    .match(/^([A-Za-z]+)\s+(\d{1,2}),\s*(\d{4})$/);
  if (match) {
    const month = MONTH_INDEX_BY_NAME[match[1].toLowerCase()];
    if (month) {
      return `${match[3]}-${month}-${String(Number(match[2])).padStart(2, '0')}`;
    }
  }
  return '2026-11-23';
}

function serializeJsonLd(data) {
  return JSON.stringify(data, null, 2)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026');
}

function buildHomepageJsonLd(copy) {
  return {
    '@context': 'https://schema.org',
    '@graph': [
      {
        '@type': 'SoftwareApplication',
        name: copy.extensionTitle,
        alternateName: copy.brandName,
        applicationCategory: 'BrowserApplication',
        applicationSubCategory: 'Productivity',
        operatingSystem: 'Chrome',
        softwareVersion: copy.version,
        description: stripInlineMarkdown(copy.overviewLead),
        url: copy.urls.homepage,
        installUrl: copy.urls.chromeWebStore,
        image: `${copy.urls.homepage}icon128.png`,
        license: 'https://www.apache.org/licenses/LICENSE-2.0',
        offers: {
          '@type': 'Offer',
          price: '0',
          priceCurrency: 'USD',
        },
      },
      {
        '@type': 'FAQPage',
        mainEntity: copy.faqs.map((item) => ({
          '@type': 'Question',
          name: item.question,
          acceptedAnswer: {
            '@type': 'Answer',
            text: stripInlineMarkdown(item.answer),
          },
        })),
      },
    ],
  };
}

function renderPolicyMarkdown(doc, copy) {
  const lines = [`# ${doc.heading}`, '', `**Last updated:** ${copy.lastUpdated}`, ''];
  lines.push(replacePlaceholders(doc.intro, 'md'));

  for (const sec of doc.sections) {
    lines.push('', `## ${sec.heading}`, '');
    if (sec.lead) {
      lines.push(replacePlaceholders(sec.lead, 'md'), '');
    }
    if (sec.paragraphs) {
      for (let i = 0; i < sec.paragraphs.length; i += 1) {
        if (i > 0) lines.push('');
        lines.push(replacePlaceholders(sec.paragraphs[i], 'md'));
      }
    }
    if (sec.orderedList) {
      sec.orderedList.forEach((item, idx) => {
        lines.push(`${idx + 1}. ${replacePlaceholders(item, 'md')}`);
      });
    }
    if (sec.unorderedList) {
      for (const item of sec.unorderedList) {
        lines.push(`- ${replacePlaceholders(item, 'md')}`);
      }
    }
    if (sec.outro) {
      lines.push('', replacePlaceholders(sec.outro, 'md'));
    }
  }

  lines.push('');
  return lines.join('\n');
}

const SHARED_DOC_CSS = `      :root {
        --bg: #f5f6f8;
        --card: #ffffff;
        --surface: #f5f6f8;
        --text: #141518;
        --sub: #525866;
        --muted: #767c89;
        --border: rgba(15, 18, 24, 0.09);
        --border-strong: rgba(15, 18, 24, 0.15);
        --accent: #1a73e8;
        --accent-hover: #155fc4;
        --accent-soft: rgba(26, 115, 232, 0.09);
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #131416;
          --card: #1c1d20;
          --surface: #25262b;
          --text: #f3f4f6;
          --sub: #a6abb6;
          --muted: #7c828f;
          --border: rgba(255, 255, 255, 0.09);
          --border-strong: rgba(255, 255, 255, 0.16);
          --accent: #5b9df9;
          --accent-hover: #428bf7;
          --accent-soft: rgba(91, 157, 249, 0.14);
        }
      }
      * {
        box-sizing: border-box;
        margin: 0;
        padding: 0;
      }
      body {
        font-family: system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
        background: var(--bg);
        color: var(--text);
        line-height: 1.65;
        padding: 44px 20px 64px;
        -webkit-font-smoothing: antialiased;
      }
      code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace;
        font-size: 12.5px;
        background: var(--accent-soft);
        color: var(--text);
        padding: 2px 5px;
        border-radius: 4px;
      }
      a {
        color: var(--accent);
        text-decoration: none;
      }
      a:hover {
        text-decoration: underline;
      }
      .site-footer {
        padding-top: 10px;
        border-top: 1px solid var(--border);
        display: flex;
        align-items: center;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 12px;
        font-size: 12.5px;
        color: var(--muted);
      }
      .site-footer-links {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        flex-wrap: wrap;
      }
      .site-footer a {
        color: var(--muted);
      }
      .site-footer a:hover {
        color: var(--text);
        text-decoration: none;
      }`;

function renderWebFooterHtml(copy, { isHomepage = false } = {}) {
  const homePart = isHomepage
    ? ''
    : `          <a href="index.html">Home</a>\n          <span aria-hidden="true">&middot;</span>\n`;
  return `      <footer class="site-footer">
        <span>${escapeHtml(copy.footerLeft)}</span>
        <nav class="site-footer-links" aria-label="SaveShot links">
${homePart}          <a href="thanks.html">Say thanks</a>
          <span aria-hidden="true">&middot;</span>
          <a href="privacy.html">Privacy</a>
          <span aria-hidden="true">&middot;</span>
          <a href="terms.html">Terms</a>
          <span aria-hidden="true">&middot;</span>
          <a href="${escapeHtml(copy.urls.authorUrl)}" target="_blank" rel="noopener noreferrer">${escapeHtml(copy.urls.authorHandle)}</a>
        </nav>
      </footer>`;
}

function renderPolicyHtml(doc, pageTitle, copy, canonicalUrl) {
  const bodyParts = [];
  bodyParts.push(
    `        <a class="top-link" href="index.html"><img src="icon32.png" alt="" width="18" height="18" /><span>&larr; Back to ${escapeHtml(copy.brandName)}</span></a>`
  );
  bodyParts.push(`        <h1>${escapeHtml(doc.heading)}</h1>`);
  bodyParts.push(`        <p class="updated">Last updated: ${escapeHtml(copy.lastUpdated)}</p>`);
  bodyParts.push(`        <p>${inlineMarkdownToHtml(replacePlaceholders(doc.intro, 'html'))}</p>`);

  for (const sec of doc.sections) {
    bodyParts.push(`        <h2>${escapeHtml(sec.heading)}</h2>`);
    if (sec.lead) {
      bodyParts.push(`        <p>${inlineMarkdownToHtml(replacePlaceholders(sec.lead, 'html'))}</p>`);
    }
    if (sec.paragraphs) {
      for (const p of sec.paragraphs) {
        bodyParts.push(`        <p>${inlineMarkdownToHtml(replacePlaceholders(p, 'html'))}</p>`);
      }
    }
    if (sec.orderedList) {
      bodyParts.push('        <ol>');
      for (const item of sec.orderedList) {
        bodyParts.push(`          <li>${inlineMarkdownToHtml(replacePlaceholders(item, 'html'))}</li>`);
      }
      bodyParts.push('        </ol>');
    }
    if (sec.unorderedList) {
      bodyParts.push('        <ul>');
      for (const item of sec.unorderedList) {
        bodyParts.push(`          <li>${inlineMarkdownToHtml(replacePlaceholders(item, 'html'))}</li>`);
      }
      bodyParts.push('        </ul>');
    }
    if (sec.outro) {
      bodyParts.push(`        <p class="outro">${inlineMarkdownToHtml(replacePlaceholders(sec.outro, 'html'))}</p>`);
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="google-site-verification" content="${escapeHtml(copy.googleSiteVerification)}" />
    <link rel="canonical" href="${escapeHtml(canonicalUrl)}" />
    <link rel="icon" type="image/png" sizes="32x32" href="icon32.png" />
    <link rel="icon" type="image/png" sizes="128x128" href="icon128.png" />
    <title>${escapeHtml(pageTitle)}</title>
    <style>
${SHARED_DOC_CSS}
      .shell {
        max-width: 720px;
        margin: 0 auto;
        display: flex;
        flex-direction: column;
        gap: 20px;
      }
      .wrap {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 16px;
        padding: 36px;
      }
      h1 {
        font-size: 24px;
        font-weight: 700;
        letter-spacing: -0.02em;
        margin-bottom: 4px;
      }
      .updated {
        font-size: 13px;
        color: var(--muted);
        margin-bottom: 20px;
      }
      h2 {
        font-size: 16px;
        font-weight: 600;
        margin-top: 24px;
        margin-bottom: 8px;
      }
      p,
      li {
        font-size: 14.5px;
        color: var(--sub);
      }
      p + p,
      .outro {
        margin-top: 10px;
      }
      ul,
      ol {
        padding-left: 22px;
        display: flex;
        flex-direction: column;
        gap: 6px;
        margin-top: 6px;
      }
      .top-link {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        font-size: 13px;
        font-weight: 500;
        margin-bottom: 16px;
      }
      .top-link img {
        display: block;
      }
    </style>
  </head>
  <body>
    <main class="shell">
      <div class="wrap">
${bodyParts.join('\n')}
      </div>
${renderWebFooterHtml(copy)}
    </main>
  </body>
</html>
`;
}

const EXTERNAL_LINK_SVG =
  '<svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"></path><polyline points="15 3 21 3 21 9"></polyline><line x1="10" y1="14" x2="21" y2="3"></line></svg>';

function renderIndexHtml(copy) {
  const cardsHtml = copy.features
    .map(
      (f) => `        <div class="card">
          <h2>${inlineMarkdownToHtml(f.webTitle)}</h2>
          <p>${inlineMarkdownToHtml(f.summary)}</p>
        </div>`
    )
    .join('\n');

  const faqsHtml = copy.faqs
    .map(
      (item, idx) => `        <details${idx === 0 ? ' open' : ''}>
          <summary>
            <span>${escapeHtml(item.question)}</span>
            <svg class="faq-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><polyline points="6 9 12 15 18 9"></polyline></svg>
          </summary>
          <p class="faq-answer">${inlineMarkdownToHtml(item.answer)}</p>
        </details>`
    )
    .join('\n');

  const sup = copy.supportCard;
  const jsonLdScript = serializeJsonLd(buildHomepageJsonLd(copy));

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="google-site-verification" content="${escapeHtml(copy.googleSiteVerification)}" />
    <link rel="canonical" href="${escapeHtml(copy.urls.homepage)}" />
    <link rel="icon" type="image/png" sizes="32x32" href="icon32.png" />
    <link rel="icon" type="image/png" sizes="128x128" href="icon128.png" />
    <link rel="alternate" type="text/plain" href="llms.txt" title="SaveShot LLMs.txt" />
    <title>${escapeHtml(copy.extensionTitle)}</title>
    <meta name="description" content="${escapeHtml(copy.shortDescription)}" />
    <script type="application/ld+json">
${jsonLdScript}
    </script>
    <style>
${SHARED_DOC_CSS}
      .wrap {
        max-width: 720px;
        margin: 0 auto;
        display: flex;
        flex-direction: column;
        gap: 22px;
      }
      .hero {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 16px;
        padding: 32px;
        display: flex;
        flex-direction: column;
        gap: 18px;
      }
      .brand {
        display: flex;
        align-items: center;
        gap: 14px;
      }
      .brand-logo {
        width: 48px;
        height: 48px;
        display: block;
        flex-shrink: 0;
      }
      h1 {
        font-size: 26px;
        font-weight: 700;
        letter-spacing: -0.025em;
        line-height: 1.2;
      }
      .lead {
        font-size: 15.5px;
        color: var(--sub);
        line-height: 1.55;
      }
      .actions {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 16px;
        padding-top: 4px;
      }
      .hero-thanks {
        font-size: 13.5px;
        color: var(--muted);
      }
      .hero-thanks a {
        font-weight: 500;
      }
      .btn {
        height: 40px;
        padding: 0 20px;
        border-radius: 9px;
        font-size: 14px;
        font-weight: 600;
        text-decoration: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        gap: 6px;
        border: 1px solid transparent;
      }
      .btn:hover {
        text-decoration: none;
      }
      .btn-sm {
        height: 34px;
        padding: 0 14px;
        border-radius: 8px;
        font-size: 13px;
        font-weight: 500;
      }
      .btn-primary {
        background: var(--accent);
        color: #ffffff;
      }
      @media (prefers-color-scheme: dark) {
        .btn-primary {
          color: #0d131f;
        }
      }
      .btn-primary:hover {
        background: var(--accent-hover);
      }
      .btn-secondary {
        background: var(--card);
        color: var(--text);
        border-color: var(--border-strong);
      }
      .btn-secondary:hover {
        background: var(--surface);
      }
      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
      }
      @media (max-width: 580px) {
        .grid {
          grid-template-columns: 1fr;
        }
      }
      .card {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 20px;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .card h2 {
        font-size: 15px;
        font-weight: 600;
      }
      .card p {
        font-size: 13.5px;
        color: var(--sub);
        line-height: 1.55;
      }
      .faq-card {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 15px;
        padding: 24px 26px;
      }
      .faq-kicker {
        font-size: 12px;
        font-weight: 600;
        text-transform: uppercase;
        letter-spacing: 0.04em;
        color: var(--muted);
        margin-bottom: 8px;
      }
      .faq-card details {
        border-top: 1px solid var(--border);
        padding: 13px 0;
      }
      .faq-card details:first-of-type {
        border-top: none;
        padding-top: 4px;
      }
      .faq-card details:last-of-type {
        padding-bottom: 2px;
      }
      .faq-card summary {
        list-style: none;
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
        font-size: 14px;
        font-weight: 600;
        color: var(--text);
        user-select: none;
      }
      .faq-card summary::-webkit-details-marker {
        display: none;
      }
      .faq-chevron {
        width: 16px;
        height: 16px;
        color: var(--muted);
        flex-shrink: 0;
        transition: transform 150ms ease;
      }
      .faq-card details[open] .faq-chevron {
        transform: rotate(180deg);
      }
      .faq-answer {
        margin-top: 7px;
        font-size: 13.5px;
        line-height: 1.58;
        color: var(--sub);
        padding-right: 24px;
      }
      .support-card {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 15px;
        padding: 22px 26px;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 18px;
        flex-wrap: wrap;
      }
      .support-copy {
        flex: 1;
        min-width: 240px;
      }
      .support-copy h2 {
        font-size: 15.5px;
        font-weight: 650;
        margin-bottom: 4px;
      }
      .support-copy p {
        font-size: 13.5px;
        color: var(--sub);
        line-height: 1.55;
      }
      .support-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex-wrap: wrap;
      }
    </style>
  </head>
  <body>
    <main class="wrap">
      <section class="hero">
        <div class="brand">
          <img class="brand-logo" src="icon128.png" alt="${escapeHtml(copy.brandName)}" width="48" height="48" />
          <div>
            <h1>${escapeHtml(copy.brandName)}</h1>
            <p class="lead">${escapeHtml(copy.tagline)}</p>
          </div>
        </div>
        <p class="lead">${inlineMarkdownToHtml(copy.overviewLead)}</p>
        <div class="actions">
          <a class="btn btn-primary" href="${escapeHtml(copy.urls.chromeWebStore)}">Add to Chrome</a>
          <span class="hero-thanks">${escapeHtml(copy.heroThanksPrompt)} <a href="thanks.html">${escapeHtml(copy.heroThanksLinkLabel)} &rarr;</a></span>
        </div>
      </section>

      <section class="grid">
${cardsHtml}
      </section>

      <section class="faq-card" id="faq">
        <h2 class="faq-kicker">Frequently asked questions</h2>
${faqsHtml}
      </section>

      <section class="support-card" id="support">
        <div class="support-copy">
          <h2>${escapeHtml(sup.heading)}</h2>
          <p>${escapeHtml(sup.body)}</p>
        </div>
        <div class="support-actions">
          <a class="btn btn-sm btn-primary" href="${escapeHtml(copy.urls.chromeWebStoreSupport)}" target="_blank" rel="noopener noreferrer"><span>${escapeHtml(sup.cwsCta)}</span>${EXTERNAL_LINK_SVG}</a>
        </div>
      </section>

${renderWebFooterHtml(copy, { isHomepage: true })}
    </main>
  </body>
</html>
`;
}

function renderThanksHtml(copy) {
  const t = copy.thanks;
  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="google-site-verification" content="${escapeHtml(copy.googleSiteVerification)}" />
    <link rel="canonical" href="${escapeHtml(copy.urls.thanksHtml)}" />
    <link rel="icon" type="image/png" sizes="32x32" href="icon32.png" />
    <link rel="icon" type="image/png" sizes="128x128" href="icon128.png" />
    <title>${escapeHtml(t.pageTitle)}</title>
    <meta name="description" content="${escapeHtml(t.lead)}" />
    <style>
${SHARED_DOC_CSS}
      .wrap {
        max-width: 720px;
        margin: 0 auto;
        display: flex;
        flex-direction: column;
        gap: 20px;
      }
      .top-link {
        display: inline-flex;
        align-items: center;
        gap: 7px;
        font-size: 13px;
        font-weight: 500;
        align-self: flex-start;
      }
      .top-link img {
        display: block;
      }
      .hero {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 16px;
        padding: 28px 32px;
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      h1 {
        font-size: 25px;
        font-weight: 700;
        letter-spacing: -0.025em;
        line-height: 1.24;
      }
      .lead {
        font-size: 15px;
        color: var(--sub);
        line-height: 1.58;
      }
      .card {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 24px 28px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        gap: 18px;
      }
      .card-top {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .card h2 {
        font-size: 17px;
        font-weight: 650;
        letter-spacing: -0.015em;
      }
      .card p {
        font-size: 14px;
        color: var(--sub);
        line-height: 1.56;
      }
      .btn {
        height: 40px;
        padding: 0 18px;
        border-radius: 9px;
        font-size: 13.5px;
        font-weight: 600;
        text-decoration: none;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        align-self: flex-start;
      }
      .btn:hover {
        text-decoration: none;
      }
      .btn-primary {
        background: var(--accent);
        color: #ffffff;
      }
      @media (prefers-color-scheme: dark) {
        .btn-primary {
          color: #0d131f;
        }
      }
      .btn-primary:hover {
        background: var(--accent-hover);
      }
    </style>
  </head>
  <body>
    <main class="wrap">
      <a class="top-link" href="index.html"><img src="icon32.png" alt="" width="18" height="18" /><span>&larr; Back to ${escapeHtml(copy.brandName)}</span></a>

      <section class="hero">
        <h1>${escapeHtml(t.heading)}</h1>
        <p class="lead">${inlineMarkdownToHtml(t.lead)}</p>
      </section>

      <section class="card">
        <div class="card-top">
          <h2>${escapeHtml(t.reviewCard.heading)}</h2>
          <p>${inlineMarkdownToHtml(t.reviewCard.body)}</p>
        </div>
        <a class="btn btn-primary" href="${escapeHtml(copy.urls.chromeWebStoreReviews)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t.reviewCard.cta)}</a>
      </section>

${renderWebFooterHtml(copy)}
    </main>
  </body>
</html>
`;
}

function renderReadmeMarkdown(copy) {
  const bullets = [
    ...copy.features.map((f) => `- ${f.readmeBullet}`),
    ...copy.readmeExtraBullets.map((b) => `- ${b}`),
  ];

  return `<p>
  <img src="icons/icon128.png" alt="${copy.brandName}" width="64" height="64" />
</p>

# ${copy.brandName}

${copy.overviewLead}

## What it does

${bullets.join('\n')}

## Reporting bugs or requesting features

${copy.readmeFeedbackParagraph}

## Privacy & Terms

${copy.readmePrivacySummary} See [PRIVACY.md](PRIVACY.md) and [TERMS.md](TERMS.md) for details.

## License

Apache License 2.0. See [LICENSE](LICENSE) for details.
`;
}

function renderStoreSeoMarkdown(copy) {
  return `# Chrome Web Store Listing & SEO Guide for ${copy.brandName}

> Generated from \`content-source/site-copy.mjs\`. Run \`npm run sync:docs\` after editing centralized copy.

## 1. Extension Name & Short Summary (\`manifest.json\`)

- **Name (\`${copy.extensionTitle.length}\` chars)**:
  \`${copy.extensionTitle}\`
- **Short Description (\`${copy.shortDescription.length}\` chars, limit \`132\`)**:
  \`${copy.shortDescription}\`

---

## 2. Recommended Category & Verified URLs

- **Primary Category**: \`Productivity\` -> \`Workflow & Planning\` *(or \`Tools\`)*
- **Language**: \`English\`
- **Official URL / Homepage**: \`${copy.urls.homepage}\`
- **Privacy Policy URL**: \`${copy.urls.privacyHtml}\`
- **Terms of Service URL**: \`${copy.urls.termsHtml}\`
- **Support URL**: \`${copy.urls.homepage}#support\`

---

## 3. Copy-Paste Full Store Description

\`\`\`text
${copy.overviewLead}

Capture, auto-copy to your clipboard, and download screenshots locally right out of the box with no sign-in required, or connect your Google Drive account once to autosave PNGs straight from Chrome.

KEY FEATURES

• Select Area, Visible Tab, Full Scrolling Page, Right-Click Menu, or Keyboard Shortcuts
Drag across any part of a webpage for pixel-exact region screenshots across Retina/HiDPI displays and browser zoom levels, press Enter for the full tab or F for a full scrolling page right from the floating bar (automatically hides repeated sticky headers and stops cleanly on Esc or infinite feeds), right-click any webpage and choose "Take Screenshot", capture the visible tab in one click, or set your preferred keyboard shortcuts in Chrome.

• Built-In Screenshot Editor: Crop, Annotate, Pixelate/Redact, Creator Tools & Smart PDF Export
Edit screenshots immediately in a new tab without leaving Chrome:
- Crop screenshots cleanly with rule-of-thirds guides (K)
- Draw arrows, rectangles, circles, lines, translucent marker highlights (hold Shift for straight lines), and freehand pencil strokes
- Add clean text callouts, switch to bold outlined Meme text (S / M / L / XL), or add a Light/Dark top Caption bar
- Paste reaction images or logos directly onto the canvas with Ctrl+V (drag to move, corner to resize)
- Hide sensitive details with permanent Solid black redaction or mosaic Pixelate redaction
- Pick preset swatches or any custom #HEX color, rotate 90 degrees, flip horizontally or vertically, undo, or reset
- Auto-copies your captured PNG straight to the clipboard by default (switch between Image, Drive Link, or Off in Settings), or click "Copy image" (Ctrl+C / Cmd+C) or "Download" (lossless PNG or smart-paged PDF that avoids clipping text at page breaks) anytime with no sign-in required
- Rename screenshots and update the existing Google Drive file while keeping the exact same share link, or turn on "Only upload when I click Save" in Settings to redact before anything is uploaded

• Organized in Your Google Drive + Instant Link Sharing
When connected, ${copy.brandName} opens the editor immediately while uploading crisp lossless PNGs in the background into a dedicated "${copy.defaultFolderName}" folder in your Google Drive (customizable in Settings). Keep your last 8 captures handy in the popup, copy share links anytime, and clear recent history automatically when you sign out.

• Offline & Full-Drive Backup Protection
If your internet drops or your Google Drive storage is full when taking a screenshot, your capture stays open in the editor with Retry, Copy image, and Download (PNG or PDF, plus Save PNG locally fallback) ready so you never lose a capture.

• Light & Neutral Graphite Dark Mode
Matches your system appearance automatically, or choose Light or Dark mode in Settings.

PRIVACY FIRST BY DESIGN

• No External Servers: Uploads go directly from your browser to Google's official Drive API (https://www.googleapis.com). ${copy.brandName} has zero private or third-party servers.
• Narrow Google Drive Permission (drive.file): ${copy.brandName} can only access the screenshots and folder it creates itself. It cannot read, list, edit, or delete any other files in your Google Drive.
• Active-Tab Only (activeTab): ${copy.brandName} never runs in the background and only captures when you click ${copy.brandName}, choose Take Screenshot from the right-click menu, or press your shortcut.
• Incognito Ready: When allowed in Incognito, ${copy.brandName} leaves page URLs out of filenames and skips local device history and temporary browser caches.
• Zero External Dependencies: Lightweight vanilla code with zero third-party libraries, SDKs, analytics, or trackers.
\`\`\`

---

## 4. Store Visual Assets (Included in \`store-assets/\`)

1. \`screenshot-1-capture-1280x800.png\` (\`1280 x 800\`) - Area, Tab & Full-Page Capture + Popup + Instant Drive Upload
2. \`screenshot-2-editor-1280x800.png\` (\`1280 x 800\`) - Built-in Editor: Crop, Annotate, Pixelate, Meme/Caption, PNG/PDF Download & Save
3. \`screenshot-3-privacy-1280x800.png\` (\`1280 x 800\`) - Privacy First, No External Servers (\`drive.file\`)
4. \`screenshot-4-themes-1280x800.png\` (\`1280 x 800\`) - Light & Graphite Dark Themes + Instant Toast Actions
5. \`screenshot-welcome-1280x800.png\` (\`1280 x 800\`) - Pin Setup, 4-Step Workflow & Customizable Shortcuts
- **Small Promo Tile (\`440 x 280\`)**: \`promo-small-440x280.png\`
- **Marquee Promo Tile (\`1400 x 560\`)**: \`promo-marquee-1400x560.png\`
`;
}

function syncAnchorHrefs(rawHtml, linkMap) {
  let nextHtml = String(rawHtml);
  for (const [id, url] of linkMap) {
    const anchorRe = new RegExp(`(<a\\b[^>]*\\bid="${id}"[^>]*>)`, 'm');
    nextHtml = nextHtml.replace(anchorRe, (anchorTag) =>
      anchorTag.replace(/href="[^"]*"/, `href="${escapeHtml(url)}"`)
    );
  }
  return nextHtml;
}

export function renderWelcomeFaqItemsHtml(copy = SITE_COPY) {
  return copy.faqs
    .map(
      (item) => `          <div class="faq-item">
            <h3 class="ss-title-sm">${escapeHtml(item.question)}</h3>
            <p class="ss-body-regular">
              ${inlineMarkdownToHtml(item.answer)}
            </p>
          </div>`
    )
    .join('\n');
}

export function syncWelcomeHtmlLinks(welcomeHtml, copy = SITE_COPY) {
  let updated = syncAnchorHrefs(welcomeHtml, [
    ['cws-support-link', copy.urls.chromeWebStoreSupport],
    ['welcome-site-link', copy.urls.homepage],
    ['welcome-thanks-link', copy.urls.thanksHtml],
    ['welcome-privacy-link', copy.urls.privacyHtml],
    ['welcome-terms-link', copy.urls.termsHtml],
    ['welcome-author-link', copy.urls.authorUrl],
  ]);

  const displayVersion = formatVersionName(copy.version, copy.buildNumber);
  const versionTooltip = formatVersionTooltip(copy.brandName, copy.version, copy.buildNumber);

  updated = updated.replace(
    /(<span class="ss-kbd" id="ext-version")(?:\s+title="[^"]*")?(>)[\s\S]*?(<\/span>)/,
    (_, open, gt, close) => `${open} title="${escapeHtml(versionTooltip)}"${gt}v${escapeHtml(displayVersion)}${close}`
  );

  updated = updated.replace(
    /(<span class="version-info-text" id="version-info-text">)[\s\S]*?(<\/span>)/,
    (_, open, close) => `${open}${escapeHtml(copy.brandName)} v${escapeHtml(displayVersion)}${close}`
  );

  updated = updated.replace(
    /(<span id="welcome-footer-left">)[\s\S]*?(<\/span>)/,
    (_, open, close) => `${open}${escapeHtml(copy.footerLeft)}${close}`
  );

  updated = updated.replace(
    /(<div class="welcome-card faq-list" id="faq-list">)[\s\S]*?(\n        <\/div>\n      <\/section>)/,
    (_, open, close) => `${open}\n${renderWelcomeFaqItemsHtml(copy)}${close}`
  );

  return updated;
}

export function syncPopupHtmlLinks(popupHtml, copy = SITE_COPY) {
  const displayVersion = formatVersionName(copy.version, copy.buildNumber);
  const versionTooltip = formatVersionTooltip(copy.brandName, copy.version, copy.buildNumber);
  const updated = syncAnchorHrefs(popupHtml, [
    ['footer-thanks-link', copy.urls.thanksHtml],
    ['footer-author-link', copy.urls.authorUrl],
  ]);
  return updated.replace(
    /(<span class="tabular" id="popup-version")(?:\s+title="[^"]*")?(>)[\s\S]*?(<\/span>)/,
    (_, open, gt, close) => `${open} title="${escapeHtml(versionTooltip)}"${gt}v${escapeHtml(displayVersion)}${close}`
  );
}

function renderLlmsTxt(copy) {
  const faqBlocks = copy.faqs
    .map((item) => `### ${item.question}\n\n${item.answer}`)
    .join('\n\n');

  return `# ${copy.brandName}

> ${copy.tagline}

${copy.overviewLead}

## Key Capabilities

- **Capture options**: Select a screen area with pixel-exact HiDPI and zoom cropping, capture a **Full page** scrolling screenshot (automatically hides repeated sticky headers, press \`Esc\` to stop early, capped safely on endless feeds), press \`Enter\` for the full tab or \`F\` for full page inside the selector, capture the visible tab in one click, right-click any webpage and choose **Take Screenshot**, or set custom keyboard shortcuts at \`chrome://extensions/shortcuts\`.
- **Built-in screenshot editor**: Crop (\`K\`), add arrows, rectangles, circles, lines, translucent marker highlights (\`H\`, hold \`Shift\` for a straight line), freehand pencil strokes, clean or bold outlined **Meme** text (\`S/M/L/XL\`), Light/Dark top **Caption bars**, paste images onto the canvas (\`Ctrl+V\`), custom \`#HEX\` colors, or permanent solid black and mosaic **Pixelate** redactions, plus rotate 90 degrees, flip, undo, or reset.
- **Instant auto-copy and local PNG/PDF export (no sign-in required)**: Automatically copies fresh captures as lossless PNGs to your clipboard by default (choose \`Image\`, \`Link\`, or \`Off\` in Settings), or click **Copy image** (\`Ctrl+C\` / \`Cmd+C\`) or **Download** (lossless PNG or smart-paged PDF that avoids clipping text at page breaks) anytime.
- **Direct Google Drive autosave**: Optionally connect Google Drive once to open the editor immediately while uploading screenshots straight from Chrome into \`${copy.defaultFolderName}\` (customizable in Settings). Turn on **Only upload when I click Save** in Settings to redact before uploading, with **Retry**, **Copy image**, and **Download** ready if Drive is offline or full.

## Privacy and Security

- **No external servers**: Screenshots stay in Chrome or upload over HTTPS directly from the browser to Google's official Drive API (\`https://www.googleapis.com\`). ${copy.brandName} operates zero private, middleman, or analytics servers.
- **Narrow permissions**: Uses \`activeTab\` and \`contextMenus\` for user-triggered capture, and Google's narrow \`https://www.googleapis.com/auth/drive.file\` scope when connected so ${copy.brandName} can only access the screenshots and folder it creates itself.
- **Incognito isolation**: When allowed in Incognito, ${copy.brandName} omits page URLs from filenames and Drive descriptions and skips local device history.

## Official Links

- [Chrome Web Store Listing](${copy.urls.chromeWebStore}): Install ${copy.brandName} (${copy.extensionTitle}, v${copy.version}).
- [Homepage](${copy.urls.homepage}): Product overview and frequently asked questions.
- [Privacy Policy](${copy.urls.privacyHtml}): Data handling and Google API Services User Data Policy Limited Use disclosure.
- [Terms of Service](${copy.urls.termsHtml}): Terms of use and Apache License 2.0 details.
- [Support and Bug Reports](${copy.urls.chromeWebStoreSupport}): Official Chrome Web Store support hub for bug reports and feature requests.
- [Say Thanks](${copy.urls.thanksHtml}): Leave a Chrome Web Store review.

## Frequently Asked Questions

${faqBlocks}
`;
}

function renderRobotsTxt(copy) {
  return `User-agent: *\nAllow: /\n\nSitemap: ${copy.urls.homepage}sitemap.xml\n`;
}

function renderSitemapXml(copy) {
  const lastmod = toIsoDate(copy.lastUpdated);
  const urls = [
    copy.urls.homepage,
    copy.urls.privacyHtml,
    copy.urls.termsHtml,
    copy.urls.thanksHtml,
  ];
  const entries = urls
    .map(
      (loc) => `  <url>
    <loc>${escapeHtml(loc)}</loc>
    <lastmod>${escapeHtml(lastmod)}</lastmod>
  </url>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${entries}
</urlset>
`;
}

export function buildGeneratedFiles(copy = SITE_COPY) {
  return {
    'README.md': renderReadmeMarkdown(copy),
    'PRIVACY.md': renderPolicyMarkdown(copy.privacy, copy),
    'TERMS.md': renderPolicyMarkdown(copy.terms, copy),
    'docs/index.html': renderIndexHtml(copy),
    'docs/thanks.html': renderThanksHtml(copy),
    'docs/privacy.html': renderPolicyHtml(copy.privacy, `Privacy Policy - ${copy.brandName}`, copy, copy.urls.privacyHtml),
    'docs/terms.html': renderPolicyHtml(copy.terms, `Terms of Service - ${copy.brandName}`, copy, copy.urls.termsHtml),
    'docs/llms.txt': renderLlmsTxt(copy),
    'docs/robots.txt': renderRobotsTxt(copy),
    'docs/sitemap.xml': renderSitemapXml(copy),
    'store-assets/STORE_LISTING_SEO.md': renderStoreSeoMarkdown(copy),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const generated = buildGeneratedFiles(SITE_COPY);
  for (const [relPath, content] of Object.entries(generated)) {
    const absPath = path.join(rootDir, relPath);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, content, 'utf8');
  }

  // Copy canonical locked icons byte-for-byte into docs/ so GitHub Pages uses the exact extension icons
  for (const iconFile of ['icon32.png', 'icon128.png']) {
    fs.copyFileSync(
      path.join(rootDir, 'icons', iconFile),
      path.join(rootDir, 'docs', iconFile)
    );
  }

  // Sync welcome.html and popup.html links, footer copy, and FAQ list from SITE_COPY
  const welcomePath = path.join(rootDir, 'pages/welcome.html');
  fs.writeFileSync(
    welcomePath,
    syncWelcomeHtmlLinks(fs.readFileSync(welcomePath, 'utf8'), SITE_COPY),
    'utf8'
  );

  const popupPath = path.join(rootDir, 'popup/popup.html');
  fs.writeFileSync(
    popupPath,
    syncPopupHtmlLinks(fs.readFileSync(popupPath, 'utf8'), SITE_COPY),
    'utf8'
  );

  // Also sync manifest.json and package.json shared metadata
  if (!Number.isInteger(SITE_COPY.buildNumber) || SITE_COPY.buildNumber < 1) {
    throw new Error(`SITE_COPY.buildNumber must be a positive integer (got ${SITE_COPY.buildNumber})`);
  }
  const displayVersion = formatVersionName(SITE_COPY.version, SITE_COPY.buildNumber);
  const manifestPath = path.join(rootDir, 'manifest.json');
  const rawManifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  const manifest = {};
  for (const [key, value] of Object.entries(rawManifest)) {
    if (key === 'version_name' || key === 'homepage_url') continue;
    manifest[key] = value;
    if (key === 'version') {
      manifest.version = SITE_COPY.version;
      manifest.version_name = displayVersion;
    }
  }
  manifest.name = SITE_COPY.extensionTitle;
  manifest.short_name = SITE_COPY.brandName;
  manifest.version = SITE_COPY.version;
  manifest.version_name = displayVersion;
  manifest.description = SITE_COPY.shortDescription;
  manifest.action.default_title = SITE_COPY.extensionTitle;
  manifest.commands['capture-region'].suggested_key.default = SITE_COPY.shortcuts.region.key;
  manifest.commands['capture-region'].suggested_key.mac = SITE_COPY.shortcuts.region.key;
  manifest.commands['capture-region'].description = SITE_COPY.shortcuts.region.manifestDescription;
  manifest.commands['capture-visible'].suggested_key.default = SITE_COPY.shortcuts.visible.key;
  manifest.commands['capture-visible'].suggested_key.mac = SITE_COPY.shortcuts.visible.key;
  manifest.commands['capture-visible'].description = SITE_COPY.shortcuts.visible.manifestDescription;
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');

  const pkgPath = path.join(rootDir, 'package.json');
  const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
  pkg.version = SITE_COPY.version;
  pkg.description = SITE_COPY.shortDescription;
  fs.writeFileSync(pkgPath, `${JSON.stringify(pkg, null, 2)}\n`, 'utf8');

  console.log(`Synced ${Object.keys(generated).length} documentation/web files + welcome.html, popup.html, manifest.json & package.json from content-source/site-copy.mjs`);
}

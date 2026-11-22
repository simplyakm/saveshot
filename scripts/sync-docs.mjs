import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { SITE_COPY } from '../content-source/site-copy.mjs';

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
  return String(text)
    .replace(/\{\{LICENSE_LINK\}\}/g, isHtml ? SITE_COPY.urls.githubLicense : 'LICENSE')
    .replace(/\{\{PRIVACY_LINK\}\}/g, isHtml ? 'privacy.html' : 'PRIVACY.md');
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
        --text: #141518;
        --sub: #525866;
        --muted: #767c89;
        --border: rgba(15, 18, 24, 0.09);
        --accent: #1a73e8;
        --accent-hover: #155fc4;
        --accent-soft: rgba(26, 115, 232, 0.09);
      }
      @media (prefers-color-scheme: dark) {
        :root {
          --bg: #131416;
          --card: #1c1d20;
          --text: #f3f4f6;
          --sub: #a6abb6;
          --muted: #7c828f;
          --border: rgba(255, 255, 255, 0.09);
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
      }`;

function renderPolicyHtml(doc, pageTitle, copy) {
  const bodyParts = [];
  bodyParts.push(
    `      <a class="top-link" href="index.html"><img src="icon32.png" alt="" width="18" height="18" /><span>&larr; Back to ${escapeHtml(copy.brandName)}</span></a>`
  );
  bodyParts.push(`      <h1>${escapeHtml(doc.heading)}</h1>`);
  bodyParts.push(`      <p class="updated">Last updated: ${escapeHtml(copy.lastUpdated)}</p>`);
  bodyParts.push(`      <p>${inlineMarkdownToHtml(replacePlaceholders(doc.intro, 'html'))}</p>`);

  for (const sec of doc.sections) {
    bodyParts.push(`      <h2>${escapeHtml(sec.heading)}</h2>`);
    if (sec.lead) {
      bodyParts.push(`      <p>${inlineMarkdownToHtml(replacePlaceholders(sec.lead, 'html'))}</p>`);
    }
    if (sec.paragraphs) {
      for (const p of sec.paragraphs) {
        bodyParts.push(`      <p>${inlineMarkdownToHtml(replacePlaceholders(p, 'html'))}</p>`);
      }
    }
    if (sec.orderedList) {
      bodyParts.push('      <ol>');
      for (const item of sec.orderedList) {
        bodyParts.push(`        <li>${inlineMarkdownToHtml(replacePlaceholders(item, 'html'))}</li>`);
      }
      bodyParts.push('      </ol>');
    }
    if (sec.unorderedList) {
      bodyParts.push('      <ul>');
      for (const item of sec.unorderedList) {
        bodyParts.push(`        <li>${inlineMarkdownToHtml(replacePlaceholders(item, 'html'))}</li>`);
      }
      bodyParts.push('      </ul>');
    }
    if (sec.outro) {
      bodyParts.push(`      <p class="outro">${inlineMarkdownToHtml(replacePlaceholders(sec.outro, 'html'))}</p>`);
    }
  }

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="google-site-verification" content="${escapeHtml(copy.googleSiteVerification)}" />
    <link rel="icon" type="image/png" sizes="32x32" href="icon32.png" />
    <link rel="icon" type="image/png" sizes="128x128" href="icon128.png" />
    <title>${escapeHtml(pageTitle)}</title>
    <style>
${SHARED_DOC_CSS}
      .wrap {
        max-width: 720px;
        margin: 0 auto;
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
    <main class="wrap">
${bodyParts.join('\n')}
    </main>
  </body>
</html>
`;
}

function renderIndexHtml(copy) {
  const cardsHtml = copy.features
    .map(
      (f) => `        <div class="card">
          <h2>${inlineMarkdownToHtml(f.webTitle)}</h2>
          <p>${inlineMarkdownToHtml(f.summary)}</p>
        </div>`
    )
    .join('\n');

  return `<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <meta name="google-site-verification" content="${escapeHtml(copy.googleSiteVerification)}" />
    <link rel="icon" type="image/png" sizes="32x32" href="icon32.png" />
    <link rel="icon" type="image/png" sizes="128x128" href="icon128.png" />
    <title>${escapeHtml(copy.extensionTitle)}</title>
    <meta name="description" content="${escapeHtml(copy.shortDescription)}" />
    <style>
${SHARED_DOC_CSS}
      .wrap {
        max-width: 720px;
        margin: 0 auto;
        display: flex;
        flex-direction: column;
        gap: 24px;
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
        flex-wrap: wrap;
        gap: 10px;
        padding-top: 4px;
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
      footer {
        display: flex;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 12px;
        font-size: 13px;
        color: var(--muted);
        padding-top: 8px;
      }
      footer a {
        color: var(--sub);
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
        </div>
      </section>

      <section class="grid">
${cardsHtml}
      </section>

      <footer>
        <span>${escapeHtml(copy.brandName)} · 100% local in Chrome · No external servers or tracking</span>
        <div>
          <a href="thanks.html">Say thanks</a> ·
          <a href="privacy.html">Privacy Policy</a> ·
          <a href="terms.html">Terms of Service</a> ·
          <a href="${escapeHtml(copy.urls.authorUrl)}">${escapeHtml(copy.urls.authorHandle)}</a>
        </div>
      </footer>
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
      .grid {
        display: grid;
        grid-template-columns: repeat(2, minmax(0, 1fr));
        gap: 14px;
      }
      @media (max-width: 600px) {
        .grid {
          grid-template-columns: 1fr;
        }
      }
      .card {
        background: var(--card);
        border: 1px solid var(--border);
        border-radius: 14px;
        padding: 24px;
        display: flex;
        flex-direction: column;
        justify-content: space-between;
        gap: 18px;
      }
      .card-top {
        display: flex;
        flex-direction: column;
        gap: 8px;
      }
      .card-meta {
        align-self: flex-start;
        font-size: 11.5px;
        font-weight: 600;
        padding: 3px 9px;
        border-radius: 6px;
        background: var(--accent-soft);
        color: var(--accent);
      }
      .card-meta.neutral {
        background: rgba(120, 126, 140, 0.12);
        color: var(--sub);
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
      .btn-secondary {
        background: transparent;
        color: var(--text);
        border: 1px solid var(--border);
      }
      .btn-secondary:hover {
        background: rgba(120, 126, 140, 0.08);
      }
      .note {
        font-size: 13px;
        color: var(--muted);
        text-align: center;
        padding-top: 2px;
      }
      footer {
        display: flex;
        justify-content: space-between;
        flex-wrap: wrap;
        gap: 12px;
        font-size: 13px;
        color: var(--muted);
        padding-top: 8px;
        border-top: 1px solid var(--border);
      }
      footer a {
        color: var(--sub);
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

      <section class="grid">
        <div class="card">
          <div class="card-top">
            <span class="card-meta">${escapeHtml(t.reviewCard.meta)}</span>
            <h2>${escapeHtml(t.reviewCard.heading)}</h2>
            <p>${inlineMarkdownToHtml(t.reviewCard.body)}</p>
          </div>
          <a class="btn btn-primary" href="${escapeHtml(copy.urls.chromeWebStoreReviews)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t.reviewCard.cta)}</a>
        </div>

        <div class="card">
          <div class="card-top">
            <span class="card-meta neutral">${escapeHtml(t.thankYouCard.meta)}</span>
            <h2>${escapeHtml(t.thankYouCard.heading)}</h2>
            <p>${inlineMarkdownToHtml(t.thankYouCard.body)}</p>
          </div>
          <a class="btn btn-secondary" href="${escapeHtml(copy.urls.topmateThanks)}" target="_blank" rel="noopener noreferrer">${escapeHtml(t.thankYouCard.cta)}</a>
        </div>
      </section>

      <p class="note">${inlineMarkdownToHtml(t.feedbackNote)}</p>

      <footer>
        <span>${escapeHtml(copy.brandName)} · 100% local in Chrome · No external servers or tracking</span>
        <div>
          <a href="index.html">Website</a> ·
          <a href="privacy.html">Privacy Policy</a> ·
          <a href="terms.html">Terms of Service</a> ·
          <a href="${escapeHtml(copy.urls.authorUrl)}">${escapeHtml(copy.urls.authorHandle)}</a>
        </div>
      </footer>
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
- **Support URL**: \`${copy.urls.homepage}\`

---

## 3. Copy-Paste Full Store Description

\`\`\`text
${copy.overviewLead}

Every screenshot uploads straight from your Chrome browser to your own Google Drive account and copies the shareable Drive link automatically.

KEY FEATURES

• Select Area or Full Visible Tab
Drag across any part of a webpage (${copy.shortcuts.region.key}) for pixel-exact region screenshots across Retina/HiDPI displays and browser zoom levels, or capture the full visible tab (${copy.shortcuts.visible.key}) in a single click. Press Enter inside the area selector anytime to grab the full tab.

• Built-In Screenshot Editor & Pixel Redaction
Annotate screenshots right in a new tab without leaving Chrome:
- Draw arrows, rectangles, circles, lines, and freehand pencil strokes
- Add clean, legible text callouts
- Permanently black out sensitive text or numbers with solid pixel redaction
- Pick preset swatches or any custom #HEX color
- Rotate 90 degrees, flip horizontally or vertically, undo, or reset
- Rename screenshots and update the existing Google Drive file while keeping the exact same share link (or turn on "Open editor before uploading" in Settings to redact before initial upload)

• Organized in Your Google Drive + Instant Link Sharing
Screenshots save as crisp lossless PNGs inside a dedicated "${copy.defaultFolderName}" folder in your Google Drive (customizable in Settings). ${copy.brandName} copies the Google Drive link to your clipboard automatically, keeps your last 8 captures handy in the popup, and clears recent history when you sign out.

• Offline & Full-Drive Backup Protection
If your internet drops or your Google Drive storage is full when taking a screenshot, ${copy.brandName} offers a one-click "Save PNG locally" fallback so you never lose a capture.

• Light & Neutral Graphite Dark Mode
Matches your system appearance automatically, or choose Light or Dark mode in Settings.

PRIVACY FIRST BY DESIGN

• 100% Local in Chrome: Uploads go directly from your browser to Google's official Drive API (https://www.googleapis.com). ${copy.brandName} has zero private or third-party servers.
• Narrow Google Drive Permission (drive.file): ${copy.brandName} can only access the screenshots and folder it creates itself. It cannot read, list, edit, or delete any other files in your Google Drive.
• Active-Tab Only (activeTab): ${copy.brandName} never runs in the background and only captures when you click ${copy.brandName} or press its shortcut.
• Incognito Ready: When allowed in Incognito, ${copy.brandName} leaves page URLs out of filenames and skips local device history.
• Zero External Dependencies: Lightweight vanilla code with zero third-party libraries, SDKs, analytics, or trackers.
\`\`\`

---

## 4. Store Visual Assets (Included in \`store-assets/\`)

1. \`screenshot-1-capture-1280x800.png\` (\`1280 x 800\`) - Region & Tab Capture + Popup + Instant Drive Upload
2. \`screenshot-2-editor-1280x800.png\` (\`1280 x 800\`) - Built-in Editor: Annotate, Redact, Rotate & Rename
3. \`screenshot-3-privacy-1280x800.png\` (\`1280 x 800\`) - 100% Local in Chrome, Zero External Servers (\`drive.file\`)
4. \`screenshot-4-themes-1280x800.png\` (\`1280 x 800\`) - Light & Graphite Dark Themes + Instant Toast Actions
5. \`screenshot-welcome-1280x800.png\` (\`1280 x 800\`) - 4-Step Setup & Keyboard Shortcuts
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

export function syncWelcomeHtmlLinks(welcomeHtml, copy = SITE_COPY) {
  return syncAnchorHrefs(welcomeHtml, [
    ['repo-issues-link', copy.urls.githubIssues],
    ['welcome-site-link', copy.urls.homepage],
    ['welcome-thanks-link', copy.urls.thanksHtml],
    ['welcome-privacy-link', copy.urls.privacyHtml],
    ['welcome-terms-link', copy.urls.termsHtml],
    ['welcome-author-link', copy.urls.authorUrl],
  ]);
}

export function syncPopupHtmlLinks(popupHtml, copy = SITE_COPY) {
  return syncAnchorHrefs(popupHtml, [
    ['footer-thanks-link', copy.urls.thanksHtml],
    ['footer-author-link', copy.urls.authorUrl],
  ]);
}

export function buildGeneratedFiles(copy = SITE_COPY) {
  return {
    'README.md': renderReadmeMarkdown(copy),
    'PRIVACY.md': renderPolicyMarkdown(copy.privacy, copy),
    'TERMS.md': renderPolicyMarkdown(copy.terms, copy),
    'docs/index.html': renderIndexHtml(copy),
    'docs/thanks.html': renderThanksHtml(copy),
    'docs/privacy.html': renderPolicyHtml(copy.privacy, `Privacy Policy - ${copy.brandName}`, copy),
    'docs/terms.html': renderPolicyHtml(copy.terms, `Terms of Service - ${copy.brandName}`, copy),
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

  // Sync welcome.html and popup.html footer links from SITE_COPY.urls
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
  const manifestPath = path.join(rootDir, 'manifest.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  manifest.name = SITE_COPY.extensionTitle;
  manifest.short_name = SITE_COPY.brandName;
  manifest.version = SITE_COPY.version;
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

  console.log(`Synced ${Object.keys(generated).length} documentation/web files + welcome.html, manifest.json & package.json from content-source/site-copy.mjs`);
}

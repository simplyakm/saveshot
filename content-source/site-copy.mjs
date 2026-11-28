/**
 * Centralized source of truth for SaveShot product copy, URLs, features, FAQs,
 * Privacy Policy, Terms of Service, README, GitHub Pages site, and Store SEO.
 *
 * After editing this file, run:
 *   npm run sync:docs
 */
export function formatVersionName(version, buildNumber) {
  const cleanVer = String(version || '').trim();
  if (typeof buildNumber === 'number' && Number.isSafeInteger(buildNumber) && buildNumber >= 1) {
    return `${cleanVer} (b${buildNumber})`;
  }
  return cleanVer;
}

export function formatVersionTooltip(brandName, version, buildNumber) {
  const cleanBrand = String(brandName || 'SaveShot').trim();
  const cleanVer = String(version || '').trim();
  if (typeof buildNumber === 'number' && Number.isSafeInteger(buildNumber) && buildNumber >= 1) {
    return `${cleanBrand} v${cleanVer} \u00b7 Build ${buildNumber}`;
  }
  return `${cleanBrand} v${cleanVer}`;
}

export const SITE_COPY = {
  brandName: 'SaveShot',
  extensionTitle: 'SaveShot: Screenshot to Google Drive',
  version: '1.3.0',
  buildNumber: 1,
  lastUpdated: 'November 26, 2026',

  // Must stay <= 132 characters for Chrome Web Store manifest.json validation
  shortDescription:
    'Capture and edit screenshots to Google Drive or download locally. Privacy-first, with no external servers or tracking.',

  tagline: 'Private screenshots straight to Google Drive or your computer.',

  overviewLead:
    'SaveShot is a privacy-first, lightweight Chrome extension for capturing an area, visible tab, or full scrolling page, cropping, highlighting, annotating, pixelating or redacting, adding meme text or caption bars, and copying PNGs straight to your clipboard with no sign-in required, or autosaving directly to your Google Drive. Everything runs in Chrome with no external servers, no tracking, and no external dependencies.',

  urls: {
    chromeWebStore:
      'https://chromewebstore.google.com/detail/eilmbilnlihhddjdmdpppalfnbnieppf',
    chromeWebStoreReviews:
      'https://chromewebstore.google.com/detail/eilmbilnlihhddjdmdpppalfnbnieppf/reviews',
    chromeWebStoreSupport:
      'https://chromewebstore.google.com/detail/eilmbilnlihhddjdmdpppalfnbnieppf/support',
    homepage: 'https://saveshot.simplyakm.com/',
    thanksHtml: 'https://saveshot.simplyakm.com/thanks.html',
    privacyHtml: 'https://saveshot.simplyakm.com/privacy.html',
    termsHtml: 'https://saveshot.simplyakm.com/terms.html',
    authorUrl: 'https://x.com/_simplyakm',
    authorHandle: '@_simplyakm',
    googleConnections: 'https://myaccount.google.com/connections',
    googleUserDataPolicy:
      'https://developers.google.com/terms/api-services-user-data-policy',
  },

  googleSiteVerification: 'ZyYQoDsqlo22U-Vpm9XZtIMK0I0vTFF3RJLMP6pkOpE',

  defaultFolderName: 'Chrome_SaveShot_ScreenShots',

  // Internal manifest.json suggested_key defaults only; never hardcoded in static user copy
  shortcuts: {
    region: {
      key: 'Alt+Shift+S',
      label: 'Select area',
      manifestDescription: 'Select a screen area with SaveShot',
    },
    visible: {
      key: 'Alt+Shift+V',
      label: 'Visible tab',
      manifestDescription: 'Capture visible tab with SaveShot',
    },
  },

  // Shared feature cards / bullets used across README.md, docs/index.html, and Store SEO
  features: [
    {
      title: 'Area, tab, or full page',
      webTitle: 'Area, Tab, or Full Page',
      summary:
        'Drag a box over any part of a webpage with pixel-exact HiDPI and zoom accuracy, scroll and stitch a **Full page** (cleanly handling sticky sidebars, floating widgets, and infinite scroll, press `Esc` to stop early), right-click any page and choose **Take Screenshot**, capture the visible tab in one click, or use customizable keyboard shortcuts.',
      readmeBullet:
        '**Select area, visible tab, full page, or right-click**: Drag a box over any part of a page, scroll and stitch a **Full page** (cleanly handling sticky sidebars, floating widgets, and infinite scroll with `Esc` early stop), right-click any page and choose **Take Screenshot**, press `Enter` for the full tab or `F` for full page, or capture the visible tab in one click.',
    },
    {
      title: 'Edit, crop, redact & create',
      webTitle: 'Edit, Crop, Redact & Create',
      summary:
        'Opens immediately in a new tab with zoom and pan controls and auto-copies your PNG to the clipboard by default (switch between `Image`, `Link`, or `Off` in Settings). Crop (`K`), highlight, annotate, use solid black or **Pixelate** redaction, switch Text to **Meme** style or add a **+ Caption bar**, paste images onto the canvas (`Ctrl+V`), rotate or flip, and download as PNG or PDF or save to Google Drive.',
      readmeBullet:
        '**Auto-copy & customizable shortcuts**: Copies your captured PNG straight to the clipboard by default (switch between `Image`, `Link`, or `Off` in Settings), and supports customizable shortcuts anytime at `chrome://extensions/shortcuts`.',
    },
    {
      title: 'No External Servers',
      webTitle: 'No External Servers',
      summary:
        'When connected, screenshots upload over HTTPS directly from your browser to Google\'s official Drive API (`https://www.googleapis.com`) into `' +
        'Chrome_SaveShot_ScreenShots` while keeping your editor instant. SaveShot has no private servers, analytics, or ads.',
      readmeBullet:
        '**Works locally or autosaves to your Drive**: Capture, auto-copy, edit, and download PNGs or PDFs locally right away without signing in, or connect Google Drive once to open the editor immediately while autosaving in the background to `Chrome_SaveShot_ScreenShots` (customizable in Settings). Turn on **Only upload when I click Save** in Settings to redact before anything is uploaded.',
    },
    {
      title: 'Narrow `drive.file` Scope',
      webTitle: 'Narrow `drive.file` Scope',
      summary:
        'Uses only `activeTab` and Google\'s narrow `drive.file` permission. SaveShot can only access the screenshots and folder it creates itself, never any other files in your Google Drive.',
      readmeBullet:
        '**Built-in lightweight editor**: Opens immediately in a new tab with zoom and pan controls so you can crop, rename, highlight text, add arrows, boxes, circles, lines, freehand strokes, clean or **Meme** text, top **Caption bars**, paste images (`Ctrl+V`), apply solid black or **Pixelate** redactions, pick custom `#HEX` colors, rotate or flip, click **Copy image** (`Ctrl+C`), click **Download** (PNG or smart-paged PDF), or click **Save** to update Google Drive.',
    },
  ],

  readmeExtraBullets: [
    '**Recent history**: Keeps your last 8 Google Drive screenshots in the popup for quick access, and clears them automatically when you sign out.',
    '**Zero-loss backup protection**: If your Google Drive is full or your internet drops, your screenshot stays open in the editor with **Retry**, **Copy image**, and **Download** (plus **Save PNG locally** fallback) ready so you never lose a capture.',
    '**Strict privacy & narrow permissions**: Uses only `activeTab` and Google\'s narrow `drive.file` scope. SaveShot runs in Chrome with zero requests to any private or third-party server, and cannot access any other files in your Google Drive.',
  ],

  // Shared 7 FAQs rendered across both docs/index.html and pages/welcome.html
  faqs: [
    {
      question: 'Do I need to sign in to capture and download screenshots?',
      answer:
        'No. You can capture an area, visible tab, or full page, crop, highlight, annotate, or redact it in the editor, and click **Copy image** or **Download** (PNG or smart-paged PDF) with no sign-in required. Connect Google Drive whenever you want automatic cloud backup and instant share links.',
    },
    {
      question: 'Does SaveShot use any external servers or track my data?',
      answer:
        'No. SaveShot runs in Chrome and uploads directly to Google Drive\'s official API. There are no SaveShot servers, no analytics, and no tracking. With Google\'s narrow `drive.file` scope, it cannot see any other files in your Drive.',
    },
    {
      question: 'Can I redact sensitive details before uploading to Google Drive?',
      answer:
        'Yes. When signed in, SaveShot opens the editor right away and uploads to Google Drive in the background by default so your share link is ready immediately. If you prefer to redact before anything is uploaded, turn on **Only upload when I click Save** in Settings (or capture while signed out).',
    },
    {
      question: 'How do keyboard shortcuts work?',
      answer:
        'SaveShot supports customizable shortcuts for both **Select area** and **Visible tab**. Inside the area selector, press `Enter` for the full tab or `F` for a full scrolling page (and `Esc` to stop a full-page capture early). You can set your preferred keys anytime at `chrome://extensions/shortcuts` (or right-click any webpage and choose **Take Screenshot**).',
    },
    {
      question: 'Why are capture buttons disabled on some tabs?',
      answer:
        'Chrome blocks all extensions from running on internal pages like `chrome://settings` and on the Chrome Web Store. For local PDFs or `file://` pages, turn on **Allow access to file URLs** in SaveShot\'s details at `chrome://extensions`.',
    },
    {
      question: 'What happens if my Google Drive is full or offline?',
      answer:
        'If a background upload fails, your screenshot stays open in the editor with a clear error message so you can click **Retry**, **Copy image**, or **Download** (PNG or PDF, plus **Save PNG locally**) without losing it.',
    },
    {
      question: 'How does Incognito mode work?',
      answer:
        'If you turn on **Allow in Incognito** in `chrome://extensions`, screenshots can still upload directly to your Google Drive while page URLs are left out of filenames and descriptions, and local upload history and temporary browser caches are skipped for privacy.',
    },
  ],

  // Shared Support / Bug Report & Feature Request card
  supportCard: {
    sectionTitle: 'Report a bug or request a feature',
    heading: 'Found a bug or want a feature?',
    body:
      'Report an issue or suggest a feature on the Chrome Web Store Support page.',
    cwsCta: 'Report on Chrome Web Store',
  },

  readmeFeedbackParagraph:
    'Click **Help** or **Report bug** inside SaveShot to copy your version info in one click and report an issue or request a feature on the [Chrome Web Store Support page](https://chromewebstore.google.com/detail/eilmbilnlihhddjdmdpppalfnbnieppf/support).',

  readmePrivacySummary:
    'SaveShot runs in your browser with no external or middleman servers. When you connect Google Drive, screenshots upload directly from Chrome to Google\'s official Drive API (`https://www.googleapis.com`) under your own account. There are no SaveShot servers, no analytics, and no tracking, and SaveShot can only access the screenshots and folder it creates.',

  // Canonical Privacy Policy (generates both PRIVACY.md and docs/privacy.html identically)
  privacy: {
    heading: 'Privacy Policy for SaveShot',
    intro:
      'SaveShot is a privacy-first Chrome extension that lets you capture and edit screenshots in your browser, download them to your computer, or save them directly to your own Google Drive. SaveShot operates with no external or private servers, no analytics, no tracking, no ads, and does not sell or share your data with anyone.',
    sections: [
      {
        heading: 'What data SaveShot accesses',
        lead: 'SaveShot only accesses data when you choose to take a screenshot or connect Google Drive:',
        orderedList: [
          '**Screenshots you capture**: When you click **Select area**, **Visible tab**, or **Full page**, choose **Take Screenshot** from the right-click menu, or press a SaveShot keyboard shortcut, Chrome captures the current tab image (or scrolls and stitches visible slices for **Full page**) so SaveShot can crop or annotate it in memory, let you copy or download it locally, or upload it directly to your Google Drive when connected. SaveShot never captures your screen in the background.',
          '**Google Drive files created by SaveShot (`drive.file`)**: SaveShot only requests Google\'s narrow `https://www.googleapis.com/auth/drive.file` permission when you choose to connect Google Drive. It can only create and access the destination folder (default: `Chrome_SaveShot_ScreenShots`) and the screenshots uploaded by SaveShot itself, plus read your Drive account display name, email, and avatar to show which Google Drive is connected in the popup. It cannot read, list, edit, or delete any of your other Google Drive files.',
        ],
      },
      {
        heading: 'Where your data goes',
        unorderedList: [
          'Screenshots are sent over HTTPS directly from your browser to Google\'s official API (`https://www.googleapis.com`) to be saved in your own Google Drive account.',
          'SaveShot never sends your screenshots, browsing history, or account details to any private, developer, or third-party server.',
        ],
      },
      {
        heading: 'What is stored on your device',
        lead: 'SaveShot stores a small amount of data locally in Chrome (`chrome.storage.local`):',
        unorderedList: [
          'Your folder name, appearance theme, auto-copy, and manual-upload ("Only upload when I click Save") settings.',
          'Your connected Google account display name, email, and avatar URL.',
          'Your last 8 uploaded screenshot links and small preview thumbnails for quick access in the popup.',
          'Short-lived, one-shot local browser cache entries used only to hand off a full-resolution PNG between the extension background worker and editor tab, deleted immediately once read (and cleared on sign-out or browser startup).',
        ],
        outro:
          'If you use SaveShot in an **Incognito** window, page URLs are left out of filenames and Drive descriptions, and screenshots are not added to local history or temporary browser caches on your device.',
      },
      {
        heading: 'Removing your data and revoking access',
        unorderedList: [
          'Click **Clear** in the popup to remove your local recent uploads list (your files remain in Google Drive).',
          'Click the **Sign out** icon in the popup to disconnect Google Drive, revoke SaveShot\'s OAuth token, and clear your cached account info and local recent uploads list.',
          'Revoke SaveShot\'s access at any time from your [Google Account Third-Party Connections](https://myaccount.google.com/connections) page.',
          'Uninstalling SaveShot from `chrome://extensions` removes all local data stored by the extension.',
        ],
      },
      {
        heading: 'Google API Services User Data Policy',
        paragraphs: [
          'SaveShot\'s use and transfer of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.',
        ],
      },
      {
        heading: 'Contact',
        paragraphs: [
          'If you have questions about this policy or want to report a privacy issue, visit the [Chrome Web Store Support page](https://chromewebstore.google.com/detail/eilmbilnlihhddjdmdpppalfnbnieppf/support).',
        ],
      },
    ],
  },

  // Canonical Terms of Service (generates both TERMS.md and docs/terms.html identically)
  terms: {
    heading: 'Terms of Service for SaveShot',
    intro:
      'By installing or using the SaveShot Chrome extension ("SaveShot"), you agree to these Terms of Service.',
    sections: [
      {
        heading: '1. What SaveShot Does',
        paragraphs: [
          'SaveShot is a free, privacy-first browser extension that runs in Chrome to capture screenshots, optionally annotate or redact them, download them to your computer, and upload them directly from your browser to your own Google Drive account using Google\'s official API. SaveShot does not operate external servers or user accounts.',
        ],
      },
      {
        heading: '2. Your Responsibilities',
        unorderedList: [
          'You are responsible for ensuring you have the right to capture, annotate, store, and share any content you screenshot using SaveShot.',
          'Your uploaded screenshots are stored in your own Google Drive account and are subject to Google\'s Terms of Service, Google Drive storage limits, and policies.',
          'SaveShot is not a backup service. You are responsible for managing and backing up files in your Google Drive.',
        ],
      },
      {
        heading: '3. License',
        paragraphs: [
          'SaveShot grants you a personal, non-exclusive license to install and use the extension in accordance with these Terms and the Apache License 2.0 included with the software package. Nothing in these Terms restricts your rights under that license.',
        ],
      },
      {
        heading: '4. Privacy',
        paragraphs: [
          'Please review our [Privacy Policy]({{PRIVACY_LINK}}), which explains how SaveShot handles data in Chrome and interacts with Google Drive under the narrow `drive.file` permission.',
        ],
      },
      {
        heading: '5. No Warranty ("As-Is")',
        paragraphs: [
          'SaveShot is provided free of charge on an **"AS IS"** and **"AS AVAILABLE"** basis, without warranties of any kind, whether express or implied, including implied warranties of merchantability, fitness for a particular purpose, or non-infringement. We do not guarantee uninterrupted operation or compatibility with every webpage or browser update.',
        ],
      },
      {
        heading: '6. Limitation of Liability',
        paragraphs: [
          'To the maximum extent permitted by applicable law, the developer and contributors of SaveShot shall not be liable for any indirect, incidental, special, consequential, or punitive damages, or any loss of data, files, or profits arising out of or related to your use of SaveShot.',
        ],
      },
      {
        heading: '7. Changes & Contact',
        paragraphs: [
          'We may update these Terms from time to time by updating the date at the top of this page. For questions, bug reports, or feature requests, visit the [Chrome Web Store Support page](https://chromewebstore.google.com/detail/eilmbilnlihhddjdmdpppalfnbnieppf/support).',
        ],
      },
    ],
  },

  footerLeft: 'SaveShot \u00b7 Privacy-first screenshot tool',

  heroThanksPrompt: 'Already using it?',
  heroThanksLinkLabel: 'Say thanks',

  // Canonical Say Thanks page (generates docs/thanks.html)
  thanks: {
    pageTitle: 'Say Thanks - SaveShot',
    heading: 'Glad SaveShot saves you time.',
    lead:
      'SaveShot is free, ad-free, and privacy-first with no external servers, subscriptions, or tracking. If it helps in your daily work, a quick review on the Chrome Web Store goes a long way.',
    reviewCard: {
      heading: 'Leave a quick review',
      body:
        'Honest ratings and reviews on the Chrome Web Store are the biggest help for a small independent extension to get discovered by more people.',
      cta: 'Rate on Chrome Web Store',
    },
  },
};

/**
 * Centralized source of truth for SaveShot product copy, URLs, features,
 * Privacy Policy, Terms of Service, README, GitHub Pages site, and Store SEO.
 *
 * After editing this file, run:
 *   npm run sync:docs
 */
export const SITE_COPY = {
  brandName: 'SaveShot',
  extensionTitle: 'SaveShot: Screenshot to Google Drive',
  version: '1.1.1',
  lastUpdated: 'November 21, 2026',

  // Must stay <= 132 characters for Chrome Web Store manifest.json validation
  shortDescription:
    'Capture and edit screenshots straight to your Google Drive. 100% local in Chrome with no external servers or tracking.',

  tagline: 'Private screenshots straight from Chrome to your Google Drive.',

  overviewLead:
    'SaveShot is a privacy-first, lightweight Chrome extension for capturing, annotating, redacting, and saving screenshots straight to your Google Drive. Uploads go directly from Chrome to your own Google Drive with no external servers, no tracking, and no external dependencies.',

  urls: {
    chromeWebStore:
      'https://chromewebstore.google.com/detail/eilmbilnlihhddjdmdpppalfnbnieppf',
    chromeWebStoreReviews:
      'https://chromewebstore.google.com/detail/eilmbilnlihhddjdmdpppalfnbnieppf/reviews',
    homepage: 'https://simplyakm.github.io/saveshot/',
    thanksHtml: 'https://simplyakm.github.io/saveshot/thanks.html',
    privacyHtml: 'https://simplyakm.github.io/saveshot/privacy.html',
    termsHtml: 'https://simplyakm.github.io/saveshot/terms.html',
    topmateThanks: 'https://topmate.io/simplyakm/2420618',
    githubRepo: 'https://github.com/simplyakm/saveshot',
    githubIssues: 'https://github.com/simplyakm/saveshot/issues',
    githubLicense: 'https://github.com/simplyakm/saveshot/blob/main/LICENSE',
    authorUrl: 'https://x.com/_simplyakm',
    authorHandle: '@_simplyakm',
    googleConnections: 'https://myaccount.google.com/connections',
    googleUserDataPolicy:
      'https://developers.google.com/terms/api-services-user-data-policy',
  },

  googleSiteVerification: 'ZyYQoDsqlo22U-Vpm9XZtIMK0I0vTFF3RJLMP6pkOpE',

  defaultFolderName: 'Chrome_SaveShot_ScreenShots',

  shortcuts: {
    region: {
      key: 'Alt+Shift+S',
      display: 'Alt + Shift + S',
      label: 'Select area',
      manifestDescription: 'Select a screen area and save to Google Drive',
    },
    visible: {
      key: 'Alt+Shift+V',
      display: 'Alt + Shift + V',
      label: 'Visible tab',
      manifestDescription: 'Capture visible tab and save to Google Drive',
    },
  },

  // Shared feature cards / bullets used across README.md, docs/index.html, and Store SEO
  features: [
    {
      title: 'Select area (`Alt+Shift+S`)',
      webTitle: 'Select Area or Full Tab',
      summary:
        'Drag a box over any part of a webpage to crop and upload just that section with pixel-exact HiDPI and zoom accuracy, press `Enter` for the full tab, or press `Alt+Shift+V` to capture the visible tab in one click.',
      readmeBullet:
        '**Select area (`Alt+Shift+S`)**: Drag a box over any part of a page to crop and upload just that section, or press `Enter` to capture the full tab.',
    },
    {
      title: 'Visible tab (`Alt+Shift+V`)',
      webTitle: 'Annotate, Redact & Rename',
      summary:
        'Opens automatically in a new tab after upload (or before upload if enabled in Settings) so you can add arrows, boxes, circles, lines, freehand strokes, text, custom `#HEX` colors, or solid black pixel redactions, rotate or flip, rename, and click **Save** to update the same Google Drive share link.',
      readmeBullet:
        '**Visible tab (`Alt+Shift+V`)**: Captures what is currently visible in the active tab.',
    },
    {
      title: '100% Local in Chrome',
      webTitle: '100% Local in Chrome',
      summary:
        'Screenshots upload over HTTPS directly from your browser to Google\'s official Drive API (`https://www.googleapis.com`) into `' +
        'Chrome_SaveShot_ScreenShots` and copy the share link automatically. SaveShot has no private servers, analytics, or ads.',
      readmeBullet:
        '**Saves straight to your Drive**: Uploads PNGs directly from Chrome to a `Chrome_SaveShot_ScreenShots` folder in your Google Drive (you can rename the folder in Settings) and copies the share link automatically.',
    },
    {
      title: 'Narrow `drive.file` Scope',
      webTitle: 'Narrow `drive.file` Scope',
      summary:
        'Uses only `activeTab` and Google\'s narrow `drive.file` permission. SaveShot can only access the screenshots and folder it creates itself, never any other files in your Google Drive.',
      readmeBullet:
        '**Built-in lightweight editor**: Opens automatically in a new tab after upload (or before uploading if you turn on **Open editor before uploading** in Settings) so you can rename the file, add arrows, boxes, circles, lines, freehand strokes, text, solid black pixel redactions, custom hex colors, rotate or flip, and press **Save** to update the Drive file while keeping the same share link.',
    },
  ],

  readmeExtraBullets: [
    '**Recent history**: Keeps your last 8 screenshots in the popup for quick access, and clears them automatically when you sign out.',
    '**Local save backup**: If your Google Drive is full or your internet drops after taking a screenshot, a **Save PNG locally** button appears so you do not lose the image.',
    '**Strict privacy & narrow permissions**: Uses only `activeTab` and Google\'s narrow `drive.file` scope. SaveShot runs 100% locally in Chrome, sends zero requests to any private or third-party server, and cannot access any other files in your Google Drive.',
  ],

  readmeFeedbackParagraph:
    'Click the **?** icon or **Report bug** at the bottom of the popup to open the built-in feedback form for bug reports and feature requests. It lets you open a pre-filled GitHub issue with basic version and error info, or copy the report as plain text.',

  readmePrivacySummary:
    'SaveShot runs 100% locally in your browser. Screenshots upload directly from Chrome to Google\'s official Drive API (`https://www.googleapis.com`) under your own account. There are no SaveShot servers, no analytics, and no tracking, and SaveShot can only access the screenshots and folder it creates.',

  // Canonical Privacy Policy (generates both PRIVACY.md and docs/privacy.html identically)
  privacy: {
    heading: 'Privacy Policy for SaveShot',
    intro:
      'SaveShot is a Chrome extension that lets you capture and edit screenshots in your browser and save them directly to your own Google Drive. SaveShot runs 100% locally in Chrome with no external or private servers, no analytics, no tracking, no ads, and does not sell or share your data with anyone.',
    sections: [
      {
        heading: 'What data SaveShot accesses',
        lead: 'SaveShot only accesses data when you choose to sign in or take a screenshot:',
        orderedList: [
          '**Screenshots you capture**: When you click **Select area**, click **Visible tab**, or press a SaveShot keyboard shortcut, Chrome captures the current tab image so SaveShot can crop or annotate it and upload it directly to your Google Drive. SaveShot never captures your screen in the background.',
          '**Google Drive files created by SaveShot (`drive.file`)**: SaveShot only requests Google\'s narrow `https://www.googleapis.com/auth/drive.file` permission. It can only create and access the destination folder (default: `Chrome_SaveShot_ScreenShots`) and the screenshots uploaded by SaveShot itself, plus read your Drive account display name, email, and avatar to show which Google Drive is connected in the popup. It cannot read, list, edit, or delete any of your other Google Drive files.',
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
          'Your folder name, appearance theme, auto-copy, and pre-upload editor settings.',
          'Your connected Google account display name, email, and avatar URL.',
          'Your last 8 uploaded screenshot links and small preview thumbnails for quick access in the popup.',
        ],
        outro:
          'If you use SaveShot in an **Incognito** window, page URLs are left out of filenames and Drive descriptions, and screenshots are not added to local history on your device.',
      },
      {
        heading: 'Removing your data and revoking access',
        unorderedList: [
          'Click **Clear** in the popup to remove your local recent uploads list (your files remain in Google Drive).',
          'Click the **Sign out** icon in the popup to revoke SaveShot\'s local token and clear your cached account info and local recent uploads list.',
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
          'If you have questions about this policy or want to report a privacy issue, use the built-in **Report bug** form inside SaveShot or reach out via [@_simplyakm](https://x.com/_simplyakm).',
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
          'SaveShot is a free browser extension that runs locally in Chrome to capture screenshots, optionally annotate or redact them, and upload them directly from your browser to your own Google Drive account using Google\'s official API. SaveShot does not operate external servers or user accounts.',
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
          'Please review our [Privacy Policy]({{PRIVACY_LINK}}), which explains how SaveShot handles data locally in Chrome and interacts with Google Drive under the narrow `drive.file` permission.',
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
          'We may update these Terms from time to time by updating the date at the top of this page. For questions or bug reports, use the built-in **Report bug** form inside SaveShot or reach out via [@_simplyakm](https://x.com/_simplyakm).',
        ],
      },
    ],
  },

  // Canonical Say Thanks / Support page (generates docs/thanks.html)
  thanks: {
    pageTitle: 'Say Thanks - SaveShot',
    heading: 'Glad SaveShot saves you time.',
    lead:
      'SaveShot is free, ad-free, and runs 100% locally in Chrome with no subscriptions or tracking. If it helps in your daily work, here are two simple ways to support it.',
    reviewCard: {
      meta: 'Free · 15 seconds',
      heading: 'Leave a quick review',
      body:
        'Honest ratings and reviews on the Chrome Web Store are the biggest help for a small independent extension to get discovered by more people.',
      cta: 'Rate on Chrome Web Store',
    },
    thankYouCard: {
      meta: 'Optional · One-time',
      heading: 'Send a thank-you',
      body:
        'Never expected, always appreciated. If you want to back independent, privacy-first tools, you can send a small thank-you (and a note on how you use SaveShot).',
      cta: 'Send a thank-you',
    },
    feedbackNote:
      'Found a bug or want a feature instead? Use **Report bug** inside the SaveShot popup or message [@_simplyakm](https://x.com/_simplyakm).',
  },
};

# Chrome Web Store Listing & SEO Guide for SaveShot

## 1. Recommended Title & Short Summary (`manifest.json`)

Chrome Web Store search weights your **Extension Name** and **Short Summary** (`manifest.json` `"name"` and `"description"`) heavily.

- **Name (`36` chars)**:
  `SaveShot: Screenshot to Google Drive`
  *(Targets exact-match searches for "screenshot to google drive", "save screenshot to google drive", and "google drive screenshot" while keeping your brand first.)*

- **Short Description (`118` chars, limit `132`)**:
  `Capture and edit screenshots straight to your Google Drive. 100% local in Chrome with no external servers or tracking.`

---

## 2. Recommended Category & Settings

- **Primary Category**: `Productivity` -> `Workflow & Planning` *(or `Tools`)*
- **Language**: `English`
- **Official URL / Homepage**: `https://simplyakm.github.io/saveshot/`
- **Support URL**: `https://github.com/simplyakm/saveshot/issues`
- **Privacy Policy URL**: `https://simplyakm.github.io/saveshot/privacy.html`

---

## 3. Copy-Paste Full Store Description (SEO & Conversion Optimized)

Paste the text below into the **Description** box on the **Store listing** tab:

```text
SaveShot is a fast, privacy-first Chrome extension to capture, annotate, redact, and save screenshots directly to your Google Drive in one click.

Every screenshot uploads straight from your Chrome browser to your own Google Drive account and copies the shareable Drive link automatically. There are no external servers, no accounts to create, no analytics, and no tracking.

KEY FEATURES

• Select Area or Full Visible Tab
Drag across any part of a webpage (Alt+Shift+S) for pixel-exact region screenshots across Retina/HiDPI displays and browser zoom levels, or capture the full visible tab (Alt+Shift+V) in a single click. Press Enter inside the area selector anytime to grab the full tab.

• Built-In Screenshot Editor & Pixel Redaction
Annotate screenshots right in a new tab without leaving Chrome:
- Draw arrows, rectangles, circles, lines, and freehand pencil strokes
- Add clean, legible text callouts
- Permanently black out sensitive text or numbers with solid pixel redaction
- Pick preset swatches or any custom #HEX color
- Rotate 90 degrees, flip horizontally or vertically, undo, or reset
- Rename screenshots and update the existing Google Drive file while keeping the exact same share link (or turn on "Open editor before uploading" in Settings to redact before initial upload)

• Organized in Your Google Drive + Instant Link Sharing
Screenshots save as crisp lossless PNGs inside a dedicated "Chrome_SaveShot_ScreenShots" folder in your Google Drive (customizable in Settings). SaveShot copies the Google Drive link to your clipboard automatically and keeps your last 8 captures handy in the popup.

• Offline & Full-Drive Backup Protection
If your internet drops or your Google Drive storage is full when taking a screenshot, SaveShot offers a one-click "Save PNG locally" fallback so you never lose a capture.

• Light & Neutral Graphite Dark Mode
Matches your system appearance automatically, or choose Light or Dark mode in Settings.

PRIVACY FIRST BY DESIGN

• 100% Local in Chrome: Uploads go directly from your browser to Google's official Drive API (https://www.googleapis.com). SaveShot has zero private or third-party servers.
• Narrow Google Drive Permission (drive.file): SaveShot can only access the screenshots and folder it creates itself. It cannot read, list, edit, or delete any other files in your Google Drive.
• Active-Tab Only (activeTab): SaveShot never runs in the background and only captures when you click SaveShot or press its shortcut.
• Incognito Ready: When allowed in Incognito, SaveShot leaves page URLs out of filenames and skips local device history.
• 100% Open Source & Zero External Dependencies: Pure, auditable code with zero third-party libraries or trackers. Source code: https://github.com/simplyakm/saveshot
```

---

## 4. Store Visual Assets (Included in `store-assets/`)

Upload screenshots in this order on the **Store listing** tab (all verified 24-bit RGB PNGs with no alpha channel):

1. `screenshot-1-capture-1280x800.png` (`1280 x 800`) - Region & Tab Capture + Popup + Instant Drive Upload
2. `screenshot-2-editor-1280x800.png` (`1280 x 800`) - Built-in Editor: Annotate, Redact, Rotate & Rename
3. `screenshot-3-privacy-1280x800.png` (`1280 x 800`) - 100% Local in Chrome, Zero External Servers (`drive.file`)
4. `screenshot-4-themes-1280x800.png` (`1280 x 800`) - Light & Graphite Dark Themes + Instant Toast Actions
5. `screenshot-welcome-1280x800.png` (`1280 x 800`) - 4-Step Setup & Keyboard Shortcuts
- **Small Promo Tile (`440 x 280`)**: `promo-small-440x280.png`
- **Marquee Promo Tile (`1400 x 560`)**: `promo-marquee-1400x560.png`

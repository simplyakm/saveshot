<p>
  <img src="icons/icon128.png" alt="SaveShot" width="64" height="64" />
</p>

# SaveShot

SaveShot is a privacy-first, lightweight Chrome extension for capturing an area, visible tab, or full scrolling page, cropping, highlighting, annotating, pixelating or redacting, adding meme text or caption bars, and copying PNGs straight to your clipboard with no sign-in required, or autosaving directly to your Google Drive. Everything runs in Chrome with no external servers, no tracking, and no external dependencies.

## What it does

- **Select area, visible tab, full page, or right-click**: Drag a box over any part of a page, scroll and stitch a **Full page** (cleanly handling sticky sidebars, floating widgets, and infinite scroll with `Esc` early stop), right-click any page and choose **Take Screenshot**, press `Enter` for the full tab or `F` for full page, or capture the visible tab in one click.
- **Auto-copy & customizable shortcuts**: Copies your captured PNG straight to the clipboard by default (switch between `Image`, `Link`, or `Off` in Settings), and supports customizable shortcuts anytime at `chrome://extensions/shortcuts`.
- **Works locally or autosaves to your Drive**: Capture, auto-copy, edit, and download PNGs or PDFs locally right away without signing in, or connect Google Drive once to open the editor immediately while autosaving in the background to `Chrome_SaveShot_ScreenShots` (customizable in Settings). Turn on **Only upload when I click Save** in Settings to redact before anything is uploaded.
- **Built-in lightweight editor**: Opens immediately in a new tab with zoom and pan controls so you can crop, rename, highlight text, add arrows, boxes, circles, lines, freehand strokes, clean or **Meme** text, top **Caption bars**, paste images (`Ctrl+V`), apply solid black or **Pixelate** redactions, pick custom `#HEX` colors, rotate or flip, click **Copy image** (`Ctrl+C`), click **Download** (PNG or smart-paged PDF), or click **Save** to update Google Drive.
- **Recent history**: Keeps your last 8 Google Drive screenshots in the popup for quick access, and clears them automatically when you sign out.
- **Zero-loss backup protection**: If your Google Drive is full or your internet drops, your screenshot stays open in the editor with **Retry**, **Copy image**, and **Download** (plus **Save PNG locally** fallback) ready so you never lose a capture.
- **Strict privacy & narrow permissions**: Uses only `activeTab` and Google's narrow `drive.file` scope. SaveShot runs in Chrome with zero requests to any private or third-party server, and cannot access any other files in your Google Drive.

## Reporting bugs or requesting features

Click **Help** or **Report bug** inside SaveShot to copy your version info in one click and report an issue or request a feature on the [Chrome Web Store Support page](https://chromewebstore.google.com/detail/eilmbilnlihhddjdmdpppalfnbnieppf/support).

## Privacy & Terms

SaveShot runs in your browser with no external or middleman servers. When you connect Google Drive, screenshots upload directly from Chrome to Google's official Drive API (`https://www.googleapis.com`) under your own account. There are no SaveShot servers, no analytics, and no tracking, and SaveShot can only access the screenshots and folder it creates. See [PRIVACY.md](PRIVACY.md) and [TERMS.md](TERMS.md) for details.

## License

Apache License 2.0. See [LICENSE](LICENSE) for details.

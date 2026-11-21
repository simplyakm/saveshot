<p>
  <img src="icons/icon128.png" alt="SaveShot" width="64" height="64" />
</p>

# SaveShot

SaveShot is a privacy-first, lightweight Chrome extension for capturing, annotating, redacting, and saving screenshots straight to your Google Drive. Uploads go directly from Chrome to your own Google Drive with no external servers, no tracking, and no external dependencies.

## What it does

- **Select area (`Alt+Shift+S`)**: Drag a box over any part of a page to crop and upload just that section, or press `Enter` to capture the full tab.
- **Visible tab (`Alt+Shift+V`)**: Captures what is currently visible in the active tab.
- **Saves straight to your Drive**: Uploads PNGs directly from Chrome to a `Chrome_SaveShot_ScreenShots` folder in your Google Drive (you can rename the folder in Settings) and copies the share link automatically.
- **Built-in lightweight editor**: Opens automatically in a new tab after upload (or before uploading if you turn on **Open editor before uploading** in Settings) so you can rename the file, add arrows, boxes, circles, lines, freehand strokes, text, solid black pixel redactions, custom hex colors, rotate or flip, and press **Save** to update the Drive file while keeping the same share link.
- **Recent history**: Keeps your last 8 screenshots in the popup for quick access, and clears them automatically when you sign out.
- **Local save backup**: If your Google Drive is full or your internet drops after taking a screenshot, a **Save PNG locally** button appears so you do not lose the image.
- **Strict privacy & narrow permissions**: Uses only `activeTab` and Google's narrow `drive.file` scope. SaveShot runs 100% locally in Chrome, sends zero requests to any private or third-party server, and cannot access any other files in your Google Drive.

## Reporting bugs or requesting features

Click the **?** icon or **Report bug** at the bottom of the popup to open the built-in feedback form for bug reports and feature requests. It lets you open a pre-filled GitHub issue with basic version and error info, or copy the report as plain text.

## Privacy & Terms

SaveShot runs 100% locally in your browser. Screenshots upload directly from Chrome to Google's official Drive API (`https://www.googleapis.com`) under your own account. There are no SaveShot servers, no analytics, and no tracking, and SaveShot can only access the screenshots and folder it creates. See [PRIVACY.md](PRIVACY.md) and [TERMS.md](TERMS.md) for details.

## License

Apache License 2.0. See [LICENSE](LICENSE) for details.

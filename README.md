# SaveShot

SaveShot is a privacy-first, lightweight Chrome extension for taking screenshots and saving them straight to your Google Drive. It signs in with the Google account you already use in Chrome, with no external dependencies or build step.

## What it does

- **Select area (`Alt+Shift+R`)**: Drag a box over any part of a page to crop and upload just that section, or press `Enter` to capture the full tab.
- **Visible tab (`Alt+Shift+S`)**: Captures what is currently visible in the active tab.
- **Saves to a Drive folder**: Uploads PNGs to a `Chrome_SaveShot_ScreenShots` folder in your Google Drive (you can rename the folder in Settings).
- **Quick link sharing**: Copies the Drive link after upload and keeps your last 8 screenshots in the popup for quick access.
- **Optional lightweight editor**: Click **Edit** after capture (or enable **Open editor before uploading** in Settings) to rename the file, add arrows, boxes, circles, lines, freehand strokes, text, solid black pixel redactions, custom hex colors, rotate or flip, and update the existing Drive file while keeping the same share link.
- **Local save backup**: If your Google Drive is full or your internet drops after taking a screenshot, a **Save PNG locally** button appears so you do not lose the image.
- **Narrow permissions**: Uses `activeTab` and `drive.file`. SaveShot can only access the folder and screenshots it creates, not the rest of your Google Drive.

## Reporting bugs or requesting features

Click the **?** icon or **Report bug** at the bottom of the popup to open the built-in feedback form for bug reports and feature requests. It lets you open a pre-filled GitHub issue with basic version and error info, or copy the report as plain text.

## Privacy

SaveShot has no backend server and does not collect or share user data. See [PRIVACY.md](PRIVACY.md) for details.

## License

Apache License 2.0. See [LICENSE](LICENSE) for details.

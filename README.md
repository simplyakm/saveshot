# SaveShot

SaveShot is a privacy-first, lightweight Chrome extension for taking screenshots and saving them straight to your Google Drive. It signs in with the Google account you already use in Chrome, with no external dependencies or build step.

## What it does

- **Visible tab (`Alt+Shift+S`)**: Captures what is currently visible in the active tab.
- **Select area (`Alt+Shift+R`)**: Drag a box over any part of a page to crop and upload just that section.
- **Saves to a Drive folder**: Uploads PNGs to a `Chrome_SaveShot_ScreenShots` folder in your Google Drive (you can rename the folder in Settings).
- **Quick link sharing**: Copies the Drive link after upload and keeps your last 8 screenshots in the popup for quick access.
- **Local save backup**: If your Google Drive is full or your internet drops after taking a screenshot, a **Save PNG locally** button appears so you do not lose the image.
- **Narrow permissions**: Uses `activeTab` and `drive.file`. SaveShot can only access the folder and screenshots it creates, not the rest of your Google Drive.

## Setup (local development or self-hosting)

Chrome's `chrome.identity` API ties Google sign-in to your extension ID. Set up an OAuth client ID once in Google Cloud:

1. Open `chrome://extensions`, turn on **Developer mode**, click **Load unpacked**, and select this folder. Copy the 32-character **ID** shown on the SaveShot card.
2. In the [Google Cloud Console](https://console.cloud.google.com/), create or pick a project and enable the **Google Drive API** under **APIs & Services > Library**.
3. Under **APIs & Services > OAuth consent screen**, configure your app and add these scopes:
   - `https://www.googleapis.com/auth/drive.file`
   - `https://www.googleapis.com/auth/userinfo.email`
   - `https://www.googleapis.com/auth/userinfo.profile`
   *(If the consent screen is in Testing mode, add your Google email under Test users.)*
4. Under **APIs & Services > Credentials**, click **Create Credentials > OAuth client ID**:
   - Application type: **Chrome Extension**
   - Item ID: paste the extension ID from step 1.
5. Copy the generated Client ID into `oauth2.client_id` inside `manifest.json` (and update `homepage_url` with your GitHub repo URL if needed).
6. Reload SaveShot in `chrome://extensions` and click **Connect Google Drive** in the popup.

## Notes and limitations

- Chrome blocks all extensions on internal pages (`chrome://`) and on the Chrome Web Store.
- For local files or PDFs (`file://`), turn on **Allow access to file URLs** on SaveShot's details page in `chrome://extensions`.
- If you enable **Allow in Incognito**, screenshots still upload to your Google Drive, while page URLs and local upload history are skipped.
- DRM-protected video streams (such as Netflix) appear black in screenshots due to OS content protection.

## Reporting bugs or requesting features

Click the **?** icon (or **Report bug** / **Request feature** at the bottom of the popup) to open the built-in feedback form. It lets you open a pre-filled GitHub issue with basic version and error info, or copy the report as plain text.

## Running tests

Requires Node.js 20+:

```bash
# Run unit and edge-case tests
npm run test:unit

# Run full suite (unit tests + headless Chromium end-to-end tests)
npm test
```

## Privacy

SaveShot has no backend server and does not collect or share user data. See [PRIVACY.md](PRIVACY.md) for details.

## License

Apache License 2.0. See [LICENSE](LICENSE) for details.

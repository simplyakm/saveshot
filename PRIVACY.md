# Privacy Policy for SaveShot

**Last updated:** November 21, 2026

SaveShot is a browser extension that lets you capture and edit screenshots in Chrome and save them directly to your own Google Drive. SaveShot runs 100% locally in Chrome with no external or private servers, no analytics, no tracking, no ads, and does not sell or share your data with anyone.

## What data SaveShot accesses

SaveShot only accesses data when you choose to sign in or take a screenshot:

1. **Screenshots you capture**: When you click **Select area**, click **Visible tab**, or press a SaveShot keyboard shortcut, Chrome captures the current tab image so SaveShot can crop or annotate it and upload it directly to your Google Drive. SaveShot never captures your screen in the background.
2. **Google Drive files created by SaveShot (`drive.file`)**: SaveShot only requests the single, narrow `drive.file` permission. It can only create and access the destination folder (default: `Chrome_SaveShot_ScreenShots`) and the screenshots uploaded by SaveShot itself, plus read your Drive account display name, email, and avatar to show which Google Drive is connected in the popup. It cannot read, list, edit, or delete your other Google Drive files.

## Where your data goes

- Screenshots are sent directly from your browser to Google's official API (`https://www.googleapis.com`) to be saved in your own Google Drive account.
- SaveShot never sends your screenshots, browsing history, or account details to any private, developer, or third-party server.

## What is stored on your device

SaveShot stores a small amount of data locally in Chrome (`chrome.storage.local`):

- Your folder name, theme, auto-copy, and pre-upload editor settings.
- Your connected Google account display name, email, and avatar URL.
- Your last 8 uploaded screenshot links and small preview thumbnails for quick access in the popup.

If you use SaveShot in an **Incognito** window, page URLs are left out of filenames and Drive descriptions, and screenshots are not added to local history on your device.

## Removing your data and revoking access

- Click **Clear** in the popup to remove your local recent uploads list (your files remain in Google Drive).
- Click the **Sign out** icon in the popup to revoke SaveShot's local token and clear your cached account info and local recent uploads list.
- You can also revoke SaveShot's access at any time from your [Google Account Third-Party Connections](https://myaccount.google.com/connections) page.
- Uninstalling SaveShot from `chrome://extensions` removes all local data stored by the extension.

## Google API Services User Data Policy

SaveShot's use and transfer of information received from Google APIs adheres to the [Google API Services User Data Policy](https://developers.google.com/terms/api-services-user-data-policy), including the Limited Use requirements.

## Contact

If you have questions about this policy or want to report a privacy issue, please open an issue on the SaveShot GitHub repository.

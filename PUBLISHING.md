# Publishing ReLeet

This guide takes you from the source folder to a listing in the Chrome Web Store. You do these steps once. Google Calendar sign-in needs a Google Cloud OAuth client, and that client needs the store's item ID, so the order below matters.

## 1. Create a developer account

1. Go to the [Chrome Web Store Developer Dashboard](https://chrome.google.com/webstore/devconsole) and sign in with the Google account that will own the listing.
2. Accept the developer agreement and pay the one-time registration fee.

## 2. Upload a draft to get the item ID

1. Run `npm run package`. It writes `dist/releet-<version>.zip` and prints the path and size.
2. The script warns loudly that the Google client ID is still a placeholder. Ignore the warning for this first upload.
3. In the dashboard, click **New item** and upload the zip. Save it as a draft. Do not submit it yet.
4. Open the item's **Package** tab (it may be called **Build** in newer dashboards). Copy two things:
   - The **item ID**: 32 letters, such as `nobbhhofaljcgpcidedpnciilnbcblca`.
   - The **public key**, which the dashboard shows for the item. You need it only in step 4.

## 3. Set up Google Cloud

ReLeet asks for one Google permission, `calendar.app.created`. With it, ReLeet can create its own "ReLeet" calendar and manage events on that calendar. It cannot see your other calendars.

Google Calendar signs in with the Google account Chrome is signed in to.

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and sign in. Open the project picker at the top, click **New project**, name it `ReLeet`, and select it.
2. Enable the API. Open **APIs & Services**, then **Library**. Search for **Google Calendar API**, open it, and click **Enable**.
3. Set up the consent screen. Open **APIs & Services**, then **OAuth consent screen**. Newer consoles call it **Google Auth Platform**, where you click **Get started**.
   - App name: `ReLeet`. User support email: yours.
   - Audience (user type): **External**.
   - Contact email: yours. Accept the policy and create.
   - Open **Audience** and click **Publish app**, so the status changes from **Testing** to **In production**.
     While it says Testing, only the test users listed there can connect Google Calendar.
4. Add the scope. Open **Data Access** (older consoles: the **Scopes** step) and click **Add or remove scopes**. Filter for `calendar.app.created`, tick `https://www.googleapis.com/auth/calendar.app.created`, click **Update**, then **Save**.
5. Create the client. Open **Clients** (older consoles: **APIs & Services**, **Credentials**, **Create credentials**, **OAuth client ID**) and click **Create client**.
   - Application type: **Chrome Extension**.
   - Name: `ReLeet`.
   - Item ID: the store item ID from step 2.
   - Click **Create** and copy the **Client ID**. It ends in `.apps.googleusercontent.com`.
6. Open `manifest.json` and replace `YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com` with that client ID:

   ```json
   "oauth2": {
     "client_id": "1234567890-abc123.apps.googleusercontent.com",
     "scopes": ["https://www.googleapis.com/auth/calendar.app.created"]
   },
   ```

## 4. Optional: match the store ID locally

An unpacked extension gets a different ID from the store version, so Google sign-in fails when you test it locally. To fix that, add the public key from step 2 to `manifest.json`, next to `"version"`:

```json
"key": "<the public key from the dashboard>",
```

Reload the extension on `chrome://extensions`. Its ID now matches the store's, and the OAuth client from step 3 works. `npm run package` removes the `"key"` line from the packaged manifest, because the store rejects uploads that contain it.

## 5. Rebuild, upload, and fill in the listing

1. Run `npm run package` again. The placeholder warning is gone now.
2. In the dashboard, upload the new zip over the draft.
3. Fill in the **Store listing** tab: description, screenshots, icon and category. The language is English.
   The screenshots from `npm run test:browser` (in `test/browser/out/`) are a starting point.
4. Fill in the **Privacy** tab with the text below.
5. Submit the item for review.

### Single purpose

> ReLeet schedules spaced-repetition reviews of LeetCode problems you have solved and books review blocks in your calendar.

### Permission justifications

| Permission | Justification text |
| --- | --- |
| `storage` | Stores the user's review history, settings, and calendar connection state locally in the browser. |
| `alarms` | Runs the periodic check for new accepted solves and the daily summary, and keeps the calendar in sync. |
| `notifications` | Sends one daily summary of the reviews due, and tells the user when a solve made on another device is waiting to be rated. |
| `identity` | Signs the user in to Google Calendar through the Google account Chrome is signed in to (`chrome.identity.getAuthToken`). |
| `scripting` | Adds the content script to leetcode.com tabs that were already open when the extension was installed or updated. It runs nowhere else. |
| `https://leetcode.com/*` | Detects accepted solutions, reads the user's recent accepted submissions, and looks up problem titles. |
| `https://www.googleapis.com/*` | Calls the Google Calendar API to create and update review events on a calendar named "ReLeet". |
| `https://oauth2.googleapis.com/*` | Revokes the Google access token when the user disconnects Google Calendar. |
| `https://*.icloud.com/*` (optional) | Requested only when the user connects Apple Calendar. It is used to create and update review events over CalDAV. |

ReLeet has no remote code. All scripts ship in the package.

### Data disclosures

Tick these categories on the privacy tab, and explain them as follows.

- **Authentication information.** Google sign-in goes through Chrome, and ReLeet never sees the Google password. For Apple Calendar, the user enters an Apple ID email and an app-specific password. ReLeet stores them in the browser, the password encrypted, and sends them only to iCloud.
- **Personal communications and web history.** Do not tick these. ReLeet reads nothing else from the pages the user visits.
- **User activity and website content.** ReLeet reads the user's LeetCode username and which problems they solved, and the problem titles. It sends problem titles to Google Calendar or iCloud as calendar event text.

Then certify that you do not sell user data, do not use it for unrelated purposes, and do not use it to judge creditworthiness. ReLeet has no analytics and no telemetry.

### Privacy policy

The store requires a privacy policy URL because ReLeet handles sign-in information. Host the policy on your own domain (see step 6). It must say at least this:

> Review history is stored locally in your browser and is never sent to the developer.

It should also say that problem titles go to the user's own Google or Apple calendar, and that there is no analytics or telemetry.

## 6. Google verification

Until Google verifies the OAuth app, two limits apply:

- At most 100 users, ever, can grant access.
- Every user sees an "unverified app" screen when they connect.

To get verified, go to **Google Auth Platform**, **Verification Center**, and submit the app. Google asks for:

- A homepage, a privacy policy, and terms of service, all on a domain you own.
- A short YouTube video that demos sign-in and shows what the app does with the calendar scope.

Verification is free and takes days to weeks. You can publish to the store before it finishes.

## Accepted limitations

Mention these on the listing page or in the support notes.

- ReLeet notices the 20 most recent solves. If you solve more than 20 problems while Chrome is closed, the older ones are missed, because LeetCode returns only 20.
- Google Calendar works in Google Chrome only.
- There is no sync between computers. Use Export and Import in Settings to move your data.

## Troubleshooting

- **Connect fails with "bad client id" or an OAuth error page.** The Item ID on the Google Cloud client does not match the ID of the extension you are running. Locally, add the `"key"` from step 4.
- **Access blocked.** The app is still in **Testing** (see step 3), so only its test users can connect, or Google stopped new sign-ins at the 100-user cap (see step 6).
- **No prompt on leetcode.com right after installing or reloading ReLeet.** A tab that Chrome put to sleep gets the content script only when it reloads. Reload the tab.
- **Errors from the service worker.** On `chrome://extensions`, click **service worker** under ReLeet to open its console.

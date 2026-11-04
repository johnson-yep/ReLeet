# Setting up ReLeet

LeetCode detection, ratings and the popup work as soon as the extension is loaded. Calendars need a little
setup first:

| Calendar | What you need | Who does it |
| --- | --- | --- |
| Google Calendar | A Google Cloud project with an OAuth client ID, pasted into `manifest.json` | The person who owns this copy of the extension, once |
| Outlook / Microsoft 365 | A Microsoft Entra app registration, its client ID pasted into `lib/config.js` | The owner, once |
| Apple iCloud | An app-specific password | Each person, in Settings |

Other people using your copy of the extension don't repeat the Google or Microsoft steps; they just click
Connect and sign in. For Google, add each of them as a test user (step 2.5; up to 100 people).

Until a client ID is filled in, that calendar's **Connect** button in Settings stays disabled and says
"One-time setup needed".

## 1. Load the extension and find its ID

1. Open `chrome://extensions` and turn on **Developer mode** (top right).
2. Click **Load unpacked** and select the ReLeet folder (the one with `manifest.json`).
3. The ReLeet card shows an **ID**: 32 letters, like `nobbhhofaljcgpcidedpnciilnbcblca`. Copy it. Both Google
   and Microsoft need it.

The ID of an unpacked extension comes from the folder's location. **If you move or rename the folder, the ID
changes** and the Google and Microsoft setups stop working until you update them with the new ID.

### Optional: pin the ID

To keep the same ID wherever the folder lives, give the extension a fixed key. In a terminal (macOS or Linux;
on Windows use Git Bash or WSL), outside the extension folder:

```sh
openssl genrsa 2048 | openssl pkcs8 -topk8 -nocrypt -out releet-key.pem
openssl rsa -in releet-key.pem -pubout -outform DER | openssl base64 -A
```

The second command prints a long line. Add it to `manifest.json` as `"key": "<that line>",` (next to
`"version"`). Then reload the extension: its ID is now fixed. This prints the ID it will have:

```sh
openssl rsa -in releet-key.pem -pubout -outform DER | shasum -a 256 | head -c32 | tr 0-9a-f a-p
```

(On Linux, `sha256sum` works in place of `shasum -a 256`.) Keep `releet-key.pem` private and out of the
extension folder.

## 2. Google Calendar

ReLeet asks only for the `calendar.app.created` permission: it can create its own "ReLeet" calendar and manage
events on that calendar, and can't see your other calendars.

Google Calendar signs in with the Google account Chrome itself is signed in to (`chrome://settings/people`).

1. Go to [console.cloud.google.com](https://console.cloud.google.com) and sign in. Create a project (project
   picker at the top → **New project**), name it e.g. `ReLeet`, and select it.
2. **Enable the API.** Menu → **APIs & Services** → **Library**, search for **Google Calendar API**, open it,
   click **Enable**.
3. **Consent screen.** Menu → **APIs & Services** → **OAuth consent screen** (newer consoles call this
   **Google Auth Platform**; click **Get started** if asked).
   - App name: `ReLeet`. User support email: yours.
   - Audience / User type: **External**.
   - Contact email: yours. Accept the policy and create.
4. **Scope.** Open **Data Access** (older consoles: the **Scopes** step) → **Add or remove scopes**. Filter for
   `calendar.app.created`, tick `.../auth/calendar.app.created`, click **Update**, then **Save**.
5. **Test users.** Open **Audience** (older consoles: the **Test users** step). Publishing status stays
   **Testing**. Under **Test users** click **Add users** and add your Gmail address (and anyone else who will
   use your copy, up to 100).
6. **Client ID.** Open **Clients** (older consoles: **APIs & Services** → **Credentials** → **Create
   credentials** → **OAuth client ID**) → **Create client**.
   - Application type: **Chrome Extension**.
   - Name: `ReLeet`.
   - Item ID: the extension ID from step 1.
   - Click **Create** and copy the **Client ID** (ends in `.apps.googleusercontent.com`).
7. Open `manifest.json` in the ReLeet folder and replace `YOUR_GOOGLE_CLIENT_ID.apps.googleusercontent.com`
   with your client ID:

   ```json
   "oauth2": {
     "client_id": "1234567890-abc123.apps.googleusercontent.com",
     "scopes": ["https://www.googleapis.com/auth/calendar.app.created"]
   },
   ```

8. On `chrome://extensions`, click the reload icon on the ReLeet card.
9. In ReLeet's Settings → **Google Calendar**, click **Connect** and approve.

What to expect:

- Google shows **"Google hasn't verified this app"**. That's normal for a personal project: click
  **Continue** (sometimes behind **Advanced**). Only accounts listed as test users get this far.
- While the app is in **Testing**, Google may expire the permission after about a week. ReLeet then shows
  **Reconnect** in the popup; click it and Connect again. To avoid this, go to **Audience** and click
  **Publish app** ("In production"). The unverified-app screen stays, which is fine for personal use.

## 3. Outlook / Microsoft 365

Works with personal Microsoft accounts (Outlook.com, Hotmail, Live) and with work or school accounts.

1. Go to [entra.microsoft.com](https://entra.microsoft.com) (or [portal.azure.com](https://portal.azure.com) →
   **Microsoft Entra ID**) and sign in. If your account has no directory yet, signing up for a free Azure
   account creates one.
2. **Applications** → **App registrations** → **New registration**.
   - Name: `ReLeet`.
   - Supported account types: **Accounts in any organizational directory (Any Microsoft Entra ID tenant -
     Multitenant) and personal Microsoft accounts (e.g. Skype, Xbox)**.
   - Redirect URI: platform **Single-page application (SPA)**, URI
     `https://<extension-id>.chromiumapp.org/` with your extension ID from step 1, **including the trailing
     slash**, e.g. `https://nobbhhofaljcgpcidedpnciilnbcblca.chromiumapp.org/`.
   - Click **Register**.
3. On the app's **Overview** page, copy the **Application (client) ID**.
4. **API permissions** → **Add a permission** → **Microsoft Graph** → **Delegated permissions**. Tick
   `Calendars.ReadWrite`, and under **OpenId permissions** tick `offline_access`, `openid` and `profile`.
   Click **Add permissions**. (`User.Read`, added by default, can stay.) No client secret is needed.
5. Open `lib/config.js` in the ReLeet folder and paste the ID:

   ```js
   export const OUTLOOK_CLIENT_ID = '00000000-0000-0000-0000-000000000000';
   ```

6. Reload ReLeet on `chrome://extensions`.
7. In Settings → **Outlook / Microsoft 365**, click **Connect**, sign in and accept.

What to expect:

- `Calendars.ReadWrite` lets ReLeet read and change all your calendars; Microsoft has no narrower permission.
  ReLeet only touches the "ReLeet" calendar it creates.
- Microsoft limits this kind of sign-in to about 24 hours at a time. ReLeet renews it silently while your
  Microsoft session in the browser is alive; if that fails, the popup shows **Reconnect**.
- Some work or school accounts need an administrator to approve the app before you can connect.

## 4. Apple iCloud

iCloud has no sign-in window for extensions, so ReLeet uses an **app-specific password**: a separate password
just for ReLeet that you can revoke at any time. It is not your Apple ID password.

1. Go to [account.apple.com](https://account.apple.com) and sign in (your Apple ID needs two-factor
   authentication, which most have).
2. **Sign-In and Security** → **App-Specific Passwords** → **Generate an app-specific password** (the **+**
   button). Name it `ReLeet` and copy the password (`xxxx-xxxx-xxxx-xxxx`).
3. In ReLeet's Settings → **Apple iCloud**, enter your Apple ID email and that password, and click
   **Connect**.

Good to know:

- The password is stored **unencrypted** in this browser's extension storage (`chrome.storage.local`), so
  anyone with access to this Chrome profile could read it. Revoke it at account.apple.com when you stop using
  ReLeet.
- Changing your Apple ID password revokes all app-specific passwords. ReLeet then shows **Reconnect**;
  generate a new one and connect again.

## Troubleshooting

- **Connect stays disabled with "One-time setup needed"**: the client ID is missing or still the placeholder,
  or the extension wasn't reloaded after you pasted it.
- **Google: "bad client id" or an OAuth error page**: the Item ID in Google Cloud doesn't match the extension
  ID. This happens after moving the folder; update the Item ID or pin the ID (step 1).
- **Microsoft: "redirect URI ... does not match"** (AADSTS50011): the SPA redirect URI must be exactly
  `https://<extension-id>.chromiumapp.org/`, trailing slash included, under the **Single-page application**
  platform (not Web).
- **Errors from the service worker**: `chrome://extensions` → ReLeet → **service worker** opens its console.

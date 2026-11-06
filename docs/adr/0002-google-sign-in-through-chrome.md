# Google Calendar signs in through Chrome's own account

ReLeet connects Google Calendar with `chrome.identity.getAuthToken`, which uses the Google account Chrome is
signed in to. It needs no client secret, Chrome refreshes tokens itself, and most Chrome users are already signed
in. The cost: it only works in Google Chrome (not Edge, Brave or Opera, which can install from the Chrome Web
Store), and users can't pick a different Google account than Chrome's. In other browsers ReLeet says Google
Calendar needs Chrome and offers Apple Calendar.

## Considered options

- **A normal Google sign-in window (`launchWebAuthFlow`)** — works in every Chromium browser and lets users pick
  any account, but Google only gives such extensions short-lived tokens without a refresh token, so users would
  sometimes be asked to sign in again. Worth revisiting if many users are on other browsers.

# No Outlook / Microsoft 365 calendar

ReLeet briefly supported Outlook through Microsoft Graph, but publishing it needs a Microsoft Entra app
registration, and Microsoft no longer lets a personal Microsoft account register one without first creating its
own Entra directory (error AADSTS16000), a route that is unreliable for individual developers. Outlook support was
removed before the public release, along with its permissions. Users who see their calendars in Outlook can add
their iCloud or Google account to Outlook to see ReLeet's blocks there. Bring it back only with an Entra app
registered under an organization directory.

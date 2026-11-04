// Shared error type for calendar providers. Pure — no chrome.* APIs.
//
// Flags tell the sync loop what to do next:
//   reconnect        sign-in was rejected or expired; the user must reconnect in Settings
//   calendarMissing  the ReLeet calendar no longer exists (deleted by the user); recreate it
//   notFound         the event no longer exists; treat delete as done, recreate on update

export class CalendarError extends Error {
  constructor(message, { status = null, reconnect = false, calendarMissing = false, notFound = false } = {}) {
    super(message);
    this.name = 'CalendarError';
    this.status = status;
    this.reconnect = reconnect;
    this.calendarMissing = calendarMissing;
    this.notFound = notFound;
  }
}

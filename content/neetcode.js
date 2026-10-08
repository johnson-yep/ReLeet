// Runs on neetcode.io problem pages. NeetCode pushes to the GitHub repo when
// you submit, so a submit is the signal to sync right away instead of waiting
// for the next poll. Classic content script (not a module): no imports.

function notifySubmit() {
  try {
    chrome.runtime.sendMessage({ type: 'submission-started' });
  } catch {
    // Extension was reloaded; this page's script is orphaned until refresh.
  }
}

// Capture phase so the page can't swallow the click before we see it.
document.addEventListener(
  'click',
  (event) => {
    const button = event.target.closest?.('button');
    if (button && /^submit\b/i.test(button.textContent.trim())) notifySubmit();
  },
  true,
);

// Ctrl/Cmd+Enter is the usual editor shortcut for submitting. A false positive
// only costs a few extra GitHub requests.
document.addEventListener(
  'keydown',
  (event) => {
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && !event.shiftKey) notifySubmit();
  },
  true,
);

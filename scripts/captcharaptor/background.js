// Local-only background for the CaptchaRaptor benchmark build.
// Replaces upstream background.js. No network access: settings are fixed,
// pHash lookups use the bundled sqlite file, and every logging or image
// collection call is answered with nothing and stores nothing.

importScripts(chrome.runtime.getURL('background_sqlite.js'));

// Upstream defaults with auto-open and auto-solve on.
const SETTINGS = Object.freeze({
  version: 20,
  key: '',
  keys: [],
  enabled: true,
  disabled_hosts: [],
  recaptcha_auto_open: true,
  recaptcha_auto_solve: true,
  recaptcha_delay_between_clicks: 300,
  recaptcha_delay_dynamic_reveal: 850,
  recaptcha_delay_before_verify: 850,
});

// Reply id check, same as upstream: CRC-32 of a fixed salt plus the request id.
const CRC = new Uint32Array(256);
for (let n = 256; n--;) {
  let c = n;
  for (let k = 8; k--;) c = c & 1 ? 3988292384 ^ c >>> 1 : c >>> 1;
  CRC[n] = c;
}
function replyId(id) {
  let c = -1;
  for (const ch of 'b5b38eb8f40354127a85285f82a51f8b' + id) c = c >>> 8 ^ CRC[c & 255 ^ ch.charCodeAt(0)];
  return (c ^ -1) >>> 0;
}

const detected = new Map(); // tabId -> captcha kinds seen, as upstream keeps it
chrome.tabs.onRemoved.addListener(tabId => detected.delete(tabId));

const handlers = {
  'phash::lookup': ([query]) => self.queryPhash(query),
  'settings::get': () => SETTINGS,
  'settings::update': () => null,
  'tab::getURL': (_args, sender) => sender.tab && sender.tab.url,
  'tab::registerDetectedCaptcha': ([kind], sender) => {
    const tabId = sender.tab && sender.tab.id;
    if (tabId === undefined) return null;
    if (!detected.has(tabId)) detected.set(tabId, new Set());
    detected.get(tabId).add(kind);
    return null;
  },
};

chrome.runtime.onMessage.addListener((message, sender, respond) => {
  if (!Array.isArray(message) || typeof message[1] !== 'string') return;
  const op = message[1];
  // caplog::* and capimg::* (upstream's solve log and image collection) get an
  // empty reply so the content script carries on; nothing is kept.
  const run = handlers[op] || (/^(caplog|capimg)::/.test(op) ? () => null : null);
  if (!run) return;
  Promise.resolve()
    .then(() => run(message.slice(2), sender))
    .then(
      value => { respond([replyId(message[0]), value]); void chrome.runtime.lastError; },
      error => { respond([replyId(message[0]), '' + error]); void chrome.runtime.lastError; },
    );
  return true;
});

// The content script opens a "stream" port for settings updates. Settings never
// change here, so the port is only held open.
chrome.runtime.onConnect.addListener(() => {});

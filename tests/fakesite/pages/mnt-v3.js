// Test-only stand-in for reCAPTCHA v3 api.js: execute() resolves at once.
window.__mntV3 = {
  ready: function (callback) { setTimeout(callback, 0); },
  execute: function () { return Promise.resolve("{{TOKEN}}"); }
};

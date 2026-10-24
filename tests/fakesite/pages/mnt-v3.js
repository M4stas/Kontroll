// Test-only stand-in for reCAPTCHA v3 api.js: grecaptcha appears after {{DELAY_MS}} ms
// (never when negative), and execute() then resolves at once.
(function () {
  var delay = Number("{{DELAY_MS}}");
  if (delay < 0) { return; }
  setTimeout(function () {
    window.grecaptcha = Object.assign(window.grecaptcha || {}, {
      ready: function (callback) { setTimeout(callback, 0); },
      execute: function () { return Promise.resolve("{{TOKEN}}"); }
    });
  }, delay);
})();

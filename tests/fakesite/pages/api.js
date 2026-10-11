// Test-only stand-in for reCAPTCHA api.js. Minimal, written for the fake site.
(function () {
  var ORIGIN = "https://www.google.com";
  var EXTRA = "{{EXTRA_REQUEST}}";
  var widgets = window.__fakeRecaptchaWidgets || (window.__fakeRecaptchaWidgets = []);

  function render(container, options) {
    if (container.getAttribute("data-fake-rendered")) { return; }
    container.setAttribute("data-fake-rendered", "1");
    var id = widgets.length;
    var frame = document.createElement("iframe");
    frame.title = "reCAPTCHA";
    frame.width = "304";
    frame.height = "78";
    frame.setAttribute("frameborder", "0");
    frame.src = ORIGIN + "/recaptcha/api2/anchor?ar=1&k=" + encodeURIComponent(options.sitekey) +
      "&co=aHR0cHM6Ly93d3cuYXV0bzI0LmVlOjQ0Mw..&hl=et&size=normal&cb=" + id;
    container.appendChild(frame);
    widgets.push({ container: container, anchor: frame, bframe: null, sitekey: options.sitekey });
    return id;
  }

  function openChallenge(widget, id) {
    if (!widget.bframe) {
      var holder = document.createElement("div");
      holder.style.cssText = "position:absolute;left:10px;top:10px;z-index:2000000000;visibility:visible;";
      var frame = document.createElement("iframe");
      frame.title = "recaptcha challenge expires in two minutes";
      frame.width = "400";
      frame.height = "580";
      frame.setAttribute("frameborder", "0");
      frame.src = ORIGIN + "/recaptcha/api2/bframe?hl=et&v=fake&k=" + encodeURIComponent(widget.sitekey) + "&cb=" + id;
      holder.appendChild(frame);
      document.body.appendChild(holder);
      widget.bframe = holder;
    }
    widget.bframe.style.visibility = "visible";
  }

  function submit(widget, token) {
    var form = widget.container.closest("form");
    var ikey = form.querySelector("input[name=ikey]").value;
    var k = "g-recaptcha-response=" + encodeURIComponent(token) + "&ikey=" + encodeURIComponent(ikey);
    var body = "k=" + encodeURIComponent(k) + "&q=" + encodeURIComponent(form.dataset.action);
    fetch("/services/data_json.php", {
      method: "POST",
      headers: { "Content-Type": "application/x-www-form-urlencoded", "X-Requested-With": "XMLHttpRequest" },
      body: body
    }).then(function (r) { return r.json(); }).then(function (data) { window.auto24Apply(data); });
  }

  if (!window.__fakeRecaptchaListening) window.addEventListener("message", function (event) {
    if (event.origin !== ORIGIN || !event.data || !event.data.fakeRecaptcha) { return; }
    var msg = event.data;
    var widget = widgets[msg.cb];
    if (!widget) { return; }
    if (msg.type === "open") {
      openChallenge(widget, msg.cb);
    } else if (msg.type === "verified") {
      if (widget.bframe) { widget.bframe.style.visibility = "hidden"; }
      widget.anchor.contentWindow.postMessage({ fakeRecaptcha: true, type: "checked" }, ORIGIN);
      submit(widget, msg.token);
    } else if (msg.type === "success") {
      submit(widget, msg.token);
    }
  });

  window.__fakeRecaptchaListening = true;
  window.grecaptcha = { render: render };
  if (EXTRA) { fetch(EXTRA, { mode: "no-cors" }).catch(function () {}); }
  var params = new URL(document.currentScript ? document.currentScript.src : ORIGIN).searchParams;
  var onload = params.get("onload");
  if (onload && typeof window[onload] === "function") { window[onload](); }
})();

/* Anvita website chat widget. Embed:
   <script src="https://api.example.com/widget.js" data-anvita-widget="wgt_…" async></script> */
(function () {
  var script = document.currentScript || document.querySelector("script[data-anvita-widget]");
  if (!script || window.__anvitaWidget) return;
  window.__anvitaWidget = true;
  var KEY = script.getAttribute("data-anvita-widget");
  var API = new URL(script.src).origin + "/v1/public/widget/" + encodeURIComponent(KEY);
  var store = "anvita:" + KEY;
  var session = null;
  try { session = JSON.parse(localStorage.getItem(store) || "null"); } catch (e) {}
  var cursor = null, seen = {}, timer = null, open = false, cfg = null;

  function req(method, path, body) {
    var h = { "Content-Type": "application/json" };
    if (session) h.Authorization = "Bearer " + session.token;
    return fetch(API + path, { method: method, headers: h, body: body ? JSON.stringify(body) : undefined }).then(function (r) {
      if (r.status === 401 && session && path !== "/session") { session = null; try { localStorage.removeItem(store); } catch (e) {} }
      if (!r.ok) throw new Error("Request failed (" + r.status + ")");
      return r.status === 204 ? null : r.json();
    });
  }
  function ensureSession() {
    if (session) return Promise.resolve(session);
    return req("POST", "/session").then(function (s) { session = s; try { localStorage.setItem(store, JSON.stringify(s)); } catch (e) {} return s; });
  }

  var host = document.createElement("div");
  host.style.cssText = "position:fixed;bottom:20px;z-index:2147483000;";
  var root = host.attachShadow({ mode: "open" });
  root.innerHTML =
    '<style>' +
    ':host{all:initial}*{box-sizing:border-box;font-family:system-ui,-apple-system,"Segoe UI",sans-serif}' +
    '.btn{width:56px;height:56px;border-radius:28px;border:0;color:#fff;cursor:pointer;box-shadow:0 6px 24px rgba(0,0,0,.2);display:flex;align-items:center;justify-content:center}' +
    '.panel{position:absolute;bottom:68px;width:min(370px,calc(100vw - 32px));height:min(540px,calc(100vh - 110px));background:#fff;color:#111;border-radius:16px;box-shadow:0 12px 40px rgba(0,0,0,.22);display:none;flex-direction:column;overflow:hidden}' +
    '.panel.open{display:flex}.head{padding:14px 16px;color:#fff;font-weight:600;font-size:15px;display:flex;justify-content:space-between;align-items:center}' +
    '.x{background:none;border:0;color:#fff;font-size:20px;cursor:pointer}.log{flex:1;overflow-y:auto;padding:14px;display:flex;flex-direction:column;gap:8px;background:#f7f7fb}' +
    '.m{max-width:85%;padding:9px 12px;border-radius:14px;font-size:14px;line-height:1.45;white-space:pre-wrap;word-wrap:break-word}' +
    '.agent{background:#fff;border:1px solid #e6e6ef;align-self:flex-start;border-bottom-left-radius:4px}.visitor{color:#fff;align-self:flex-end;border-bottom-right-radius:4px}' +
    '.typing{font-size:12px;color:#888;padding:0 14px 6px;background:#f7f7fb;min-height:18px}form{display:flex;gap:8px;padding:10px;border-top:1px solid #eee}' +
    'input{flex:1;border:1px solid #ddd;border-radius:10px;padding:10px 12px;font-size:14px;outline:none}button.send{border:0;border-radius:10px;color:#fff;padding:0 14px;cursor:pointer;font-size:14px}' +
    '.pw{font-size:11px;color:#999;text-align:center;padding:0 0 8px}' +
    '</style>' +
    '<div class="panel" role="dialog" aria-label="Chat"><div class="head"><span class="t"></span><button class="x" aria-label="Close">×</button></div>' +
    '<div class="log" aria-live="polite"></div><div class="typing"></div>' +
    '<form><input placeholder="Type your message…" aria-label="Message" maxlength="2000"/><button class="send" type="submit">Send</button></form><div class="pw">Powered by Anvita</div></div>' +
    '<button class="btn" aria-label="Open chat"><svg width="26" height="26" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg></button>';
  var $ = function (s) { return root.querySelector(s); };
  var panel = $(".panel"), log = $(".log"), typing = $(".typing"), input = $("input"), form = $("form");

  function add(m) {
    if (m.id && seen[m.id]) return;
    if (m.id) seen[m.id] = 1;
    var d = document.createElement("div");
    d.className = "m " + m.from;
    if (m.from === "visitor") d.style.background = cfg.color;
    d.textContent = m.text;
    log.appendChild(d);
    log.scrollTop = log.scrollHeight;
  }
  function poll() {
    if (!session) return;
    req("GET", "/messages" + (cursor ? "?after=" + encodeURIComponent(cursor) : "")).then(function (r) {
      var pend = log.querySelectorAll(".pending");
      for (var i = 0; i < pend.length; i++) pend[i].remove();
      r.messages.forEach(function (m) { add(m); cursor = m.at; });
      typing.textContent = r.busy ? "Typing…" : "";
    }).catch(function () {}).then(function () {
      clearTimeout(timer);
      timer = setTimeout(poll, open ? 2000 : 15000);
    });
  }
  function toggle(v) {
    open = v;
    panel.classList.toggle("open", v);
    if (v) { input.focus(); poll(); }
  }
  $(".btn").onclick = function () { toggle(!open); };
  $(".x").onclick = function () { toggle(false); };
  form.onsubmit = function (e) {
    e.preventDefault();
    var text = input.value.trim();
    if (!text) return;
    input.value = "";
    add({ from: "visitor", text: text });
    log.lastChild.classList.add("pending");
    typing.textContent = "Typing…";
    ensureSession().then(function () { return req("POST", "/messages", { text: text }); }).then(function () { setTimeout(poll, 800); }).catch(function () { typing.textContent = "Couldn't send — please try again."; });
  };

  req("GET", "").then(function (c) {
    cfg = c;
    host.style[c.position === "left" ? "left" : "right"] = "20px";
    if (c.position === "left") panel.style.left = "0"; else panel.style.right = "0";
    $(".btn").style.background = c.color; $(".head").style.background = c.color; $(".send").style.background = c.color;
    $(".t").textContent = c.title;
    add({ from: "agent", text: c.greeting });
    document.body.appendChild(host);
    if (session) poll();
  }).catch(function () {});
})();

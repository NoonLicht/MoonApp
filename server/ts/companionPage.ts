/**
 * Страница веб-компаньона (открывается с телефона). Один HTML, один скрипт, один
 * стиль — раздаются самим сервером компаньона (server/ts/companion.ts) с жёстким CSP
 * (script-src 'self', без inline). Весь текст вставляется через textContent — ни
 * innerHTML, ни eval, поэтому содержимое заметок не может выполнить код.
 */

export const INDEX_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<meta name="color-scheme" content="dark light">
<title>MoonApp</title>
<link rel="stylesheet" href="/style.css">
</head>
<body>
<main id="app"></main>
<script src="/app.js"></script>
</body>
</html>
`;

export const STYLE_CSS = `
:root{--bg:#14121c;--card:#1f1c2b;--line:#2f2b40;--text:#eceaf5;--dim:#9a96ad;--acc:#f5a524;--ok:#2dd4bf;--bad:#ff6b6b}
@media (prefers-color-scheme: light){:root{--bg:#f6f4fb;--card:#fff;--line:#e2deee;--text:#1d1a28;--dim:#6c6880}}
*{box-sizing:border-box}
body{margin:0;background:var(--bg);color:var(--text);font:16px/1.45 system-ui,-apple-system,"Segoe UI",Roboto,sans-serif;-webkit-text-size-adjust:100%}
main{max-width:640px;margin:0 auto;padding:max(12px,env(safe-area-inset-top)) 14px 90px}
h1{font-size:20px;margin:6px 0 12px}
.card{background:var(--card);border:1px solid var(--line);border-radius:14px;padding:12px;margin:0 0 10px}
.row{display:flex;gap:8px;align-items:center}
input,textarea,button{font:inherit;color:inherit}
input,textarea{width:100%;background:transparent;border:1px solid var(--line);border-radius:10px;padding:10px 12px;outline:none}
input:focus,textarea:focus{border-color:var(--acc)}
textarea{min-height:110px;resize:vertical}
button{border:1px solid var(--line);background:var(--card);border-radius:10px;padding:10px 14px;cursor:pointer;min-height:44px}
button.pri{background:var(--acc);border-color:var(--acc);color:#1a1204;font-weight:600}
button:disabled{opacity:.5}
.dim{color:var(--dim);font-size:13px}
.err{color:var(--bad)}
.ok{color:var(--ok)}
.code{letter-spacing:.4em;text-align:center;font-size:26px}
nav{position:fixed;left:0;right:0;bottom:0;display:flex;background:var(--card);border-top:1px solid var(--line);padding-bottom:env(safe-area-inset-bottom)}
nav button{flex:1;border:none;border-radius:0;background:transparent;min-height:56px;font-size:13px}
nav button.on{color:var(--acc);font-weight:600}
.item{display:flex;gap:10px;align-items:center;padding:10px 4px;border-bottom:1px solid var(--line)}
.item:last-child{border:none}
.item .t{flex:1;min-width:0;overflow:hidden;text-overflow:ellipsis}
.done .t{text-decoration:line-through;opacity:.55}
.big{display:grid;grid-template-columns:repeat(3,1fr);gap:8px}
.big button{min-height:58px;font-size:20px}
input[type=range]{padding:0;accent-color:var(--acc)}
`;

export const APP_JS = `
(function () {
  "use strict";
  var LS = "moonapp.companion.token";
  var T = {
    en: { pairTitle: "Connect to MoonApp", pairHint: "Enter the 6-digit code shown in MoonApp: Settings → Web companion.", connect: "Connect", badCode: "Wrong or expired code.", tooMany: "Too many attempts. Wait a minute.", inbox: "Inbox", notes: "Notes", tasks: "Tasks", player: "Player", send: "Send", textPh: "Text or link to send to your PC…", sent: "Sent to the PC", pickFile: "Choose a file", uploading: "Uploading…", fileSent: "File delivered", blocked: "This file type is not accepted", failed: "Failed", search: "Search notes…", empty: "Nothing here", back: "Back", append: "Add to note", newNote: "New note", titlePh: "Title", save: "Save", addTask: "Add", taskPh: "New task…", noPlayer: "No media is playing on the PC.", forget: "Disconnect this device", offline: "Cannot reach the PC", saved: "Saved", scan: "Scanner", shoot: "Take a photo", pages: "Pages", makePdf: "Make PDF", toTasks: "Photo → tasks", clearPages: "Clear", working: "Processing on the PC…", pdfDone: "PDF is on the PC (Scans)", tasksDone: "Tasks created: ", scanHint: "Shoot a document or a whiteboard. PDF and text are made on the PC." },
    ru: { pairTitle: "Подключение к MoonApp", pairHint: "Введите 6-значный код из MoonApp: Настройки → Веб-компаньон.", connect: "Подключить", badCode: "Неверный или просроченный код.", tooMany: "Слишком много попыток. Подождите минуту.", inbox: "Входящие", notes: "Заметки", tasks: "Задачи", player: "Плеер", send: "Отправить", textPh: "Текст или ссылка для ПК…", sent: "Отправлено на ПК", pickFile: "Выбрать файл", uploading: "Загрузка…", fileSent: "Файл доставлен", blocked: "Такой тип файлов не принимается", failed: "Не удалось", search: "Поиск по заметкам…", empty: "Пусто", back: "Назад", append: "Дописать в заметку", newNote: "Новая заметка", titlePh: "Заголовок", save: "Сохранить", addTask: "Добавить", taskPh: "Новая задача…", noPlayer: "На ПК сейчас ничего не играет.", forget: "Отключить это устройство", offline: "ПК недоступен", saved: "Сохранено", scan: "Сканер", shoot: "Снять", pages: "Страниц", makePdf: "Собрать PDF", toTasks: "Фото → задачи", clearPages: "Очистить", working: "Обрабатываю на ПК…", pdfDone: "PDF на ПК (папка «Сканы»)", tasksDone: "Создано задач: ", scanHint: "Снимите документ или доску. PDF и текст делает ПК." }
  };
  var L = T[(navigator.language || "en").slice(0, 2)] || T.en;
  var root = document.getElementById("app");
  var token = null;
  try { token = localStorage.getItem(LS); } catch (e) {}

  function el(tag, props, kids) {
    var n = document.createElement(tag);
    if (props) for (var k in props) {
      if (k === "text") n.textContent = props[k];
      else if (k === "class") n.className = props[k];
      else if (k.slice(0, 2) === "on") n.addEventListener(k.slice(2), props[k]);
      else n.setAttribute(k, props[k]);
    }
    (kids || []).forEach(function (c) { if (c) n.appendChild(c); });
    return n;
  }
  function clear(n) { while (n.firstChild) n.removeChild(n.firstChild); }

  function api(method, path, body) {
    var opts = { method: method, headers: {} };
    if (token) opts.headers.Authorization = "Bearer " + token;
    if (body instanceof FormData) opts.body = body;
    else if (body !== undefined) { opts.headers["Content-Type"] = "application/json"; opts.body = JSON.stringify(body); }
    return fetch("/api" + path, opts).then(function (r) {
      return r.json().catch(function () { return {}; }).then(function (j) {
        if (r.status === 401 && token) { forget(); throw new Error("unauthorized"); }
        if (!r.ok) { var e = new Error(j.error || "error"); e.status = r.status; throw e; }
        return j;
      });
    });
  }
  function forget() { token = null; try { localStorage.removeItem(LS); } catch (e) {} render(); }

  /* ---- сопряжение ---- */
  function renderPair() {
    clear(root);
    var code = el("input", { class: "code", inputmode: "numeric", maxlength: "6", autocomplete: "one-time-code", placeholder: "••••••" });
    var msg = el("div", { class: "dim" });
    var btn = el("button", { class: "pri", text: L.connect, onclick: function () {
      msg.className = "dim"; msg.textContent = "";
      btn.disabled = true;
      var name = /iPhone|iPad/.test(navigator.userAgent) ? "iPhone" : /Android/.test(navigator.userAgent) ? "Android" : "Browser";
      api("POST", "/pair", { code: code.value, name: name }).then(function (r) {
        token = r.token; try { localStorage.setItem(LS, token); } catch (e) {}
        render();
      }).catch(function (e) {
        msg.className = "err"; msg.textContent = e.status === 429 ? L.tooMany : L.badCode; btn.disabled = false;
      });
    } });
    root.appendChild(el("h1", { text: L.pairTitle }));
    root.appendChild(el("div", { class: "card" }, [el("p", { class: "dim", text: L.pairHint }), code, el("div", { style: "height:10px" }), btn, msg]));
  }

  /* ---- вкладки ---- */
  var tab = "inbox";
  var timer = null;
  function render() {
    if (timer) { clearInterval(timer); timer = null; }
    if (!token) return renderPair();
    clear(root);
    var body = el("div");
    root.appendChild(body);
    var names = ["inbox", "notes", "tasks", "scan", "player"];
    var nav = el("nav", null, names.map(function (n) {
      return el("button", { class: n === tab ? "on" : "", text: L[n], onclick: function () { tab = n; render(); } });
    }));
    root.appendChild(nav);
    ({ inbox: viewInbox, notes: viewNotes, tasks: viewTasks, scan: viewScan, player: viewPlayer })[tab](body);
  }

  function status(node, text, cls) { node.className = cls || "dim"; node.textContent = text; }

  function viewInbox(body) {
    var ta = el("textarea", { placeholder: L.textPh });
    var st = el("div", { class: "dim" });
    var file = el("input", { type: "file", style: "display:none" });
    file.addEventListener("change", function () {
      if (!file.files[0]) return;
      var fd = new FormData(); fd.append("file", file.files[0]);
      status(st, L.uploading);
      api("POST", "/inbox/file", fd).then(function () { status(st, L.fileSent, "ok"); })
        .catch(function (e) { status(st, e.status === 415 ? L.blocked : L.failed, "err"); });
      file.value = "";
    });
    body.appendChild(el("h1", { text: L.inbox }));
    body.appendChild(el("div", { class: "card" }, [ta, el("div", { style: "height:8px" }), el("div", { class: "row" }, [
      el("button", { class: "pri", text: L.send, onclick: function () {
        if (!ta.value.trim()) return;
        api("POST", "/inbox/text", { text: ta.value }).then(function () { ta.value = ""; status(st, L.sent, "ok"); })
          .catch(function () { status(st, L.failed, "err"); });
      } }),
      el("button", { text: L.pickFile, onclick: function () { file.click(); } }), file
    ]), st]));
    body.appendChild(el("button", { class: "dim", text: L.forget, onclick: forget }));
  }

  function viewNotes(body, openId) {
    clear(body);
    if (openId) return viewNote(body, openId);
    var q = el("input", { placeholder: L.search });
    var list = el("div", { class: "card" });
    var load = function () {
      api("GET", "/notes?q=" + encodeURIComponent(q.value)).then(function (rows) {
        clear(list);
        if (!rows.length) list.appendChild(el("div", { class: "dim", text: L.empty }));
        rows.forEach(function (n) {
          list.appendChild(el("div", { class: "item", onclick: function () { viewNotes(body, n.id); } }, [
            el("div", { class: "t" }, [el("div", { text: n.title || "—" }), el("div", { class: "dim", text: n.preview })])
          ]));
        });
      }).catch(function () { list.textContent = L.offline; });
    };
    var t; q.addEventListener("input", function () { clearTimeout(t); t = setTimeout(load, 250); });
    var title = el("input", { placeholder: L.titlePh });
    var content = el("textarea", { placeholder: L.newNote });
    var st = el("div", { class: "dim" });
    body.appendChild(el("h1", { text: L.notes }));
    body.appendChild(q);
    body.appendChild(el("div", { style: "height:10px" }));
    body.appendChild(list);
    body.appendChild(el("div", { class: "card" }, [title, el("div", { style: "height:8px" }), content, el("div", { style: "height:8px" }),
      el("button", { class: "pri", text: L.save, onclick: function () {
        api("POST", "/notes", { title: title.value, content: content.value }).then(function () {
          title.value = ""; content.value = ""; status(st, L.saved, "ok"); load();
        }).catch(function () { status(st, L.failed, "err"); });
      } }), st]));
    load();
  }

  function viewNote(body, id) {
    var add = el("textarea", { placeholder: L.append });
    var st = el("div", { class: "dim" });
    var box = el("div", { class: "card", style: "white-space:pre-wrap;word-break:break-word" });
    body.appendChild(el("button", { text: L.back, onclick: function () { viewNotes(body); } }));
    body.appendChild(box);
    api("GET", "/notes/" + id).then(function (n) { box.textContent = n.title + "\\n\\n" + n.content; }).catch(function () { box.textContent = L.offline; });
    body.appendChild(el("div", { class: "card" }, [add, el("div", { style: "height:8px" }), el("button", { class: "pri", text: L.append, onclick: function () {
      api("POST", "/notes/" + id + "/append", { text: add.value }).then(function () { add.value = ""; status(st, L.saved, "ok"); viewNotes(body, id); })
        .catch(function () { status(st, L.failed, "err"); });
    } }), st]));
  }

  function viewTasks(body) {
    var input = el("input", { placeholder: L.taskPh });
    var list = el("div", { class: "card" });
    var load = function () {
      api("GET", "/tasks").then(function (rows) {
        clear(list);
        if (!rows.length) list.appendChild(el("div", { class: "dim", text: L.empty }));
        rows.forEach(function (t) {
          var done = t.status === "completed";
          list.appendChild(el("div", { class: "item" + (done ? " done" : "") }, [
            el("input", Object.assign({ type: "checkbox", style: "width:22px;height:22px", onchange: function () { api("POST", "/tasks/" + t.id + "/toggle").then(load); } }, done ? { checked: "checked" } : {})),
            el("div", { class: "t", text: t.title })
          ]));
        });
      }).catch(function () { list.textContent = L.offline; });
    };
    body.appendChild(el("h1", { text: L.tasks }));
    body.appendChild(el("div", { class: "row" }, [input, el("button", { class: "pri", text: L.addTask, onclick: function () {
      if (!input.value.trim()) return;
      api("POST", "/tasks", { title: input.value }).then(function () { input.value = ""; load(); });
    } })]));
    body.appendChild(el("div", { style: "height:10px" }));
    body.appendChild(list);
    load();
  }

  /* ---- сканер: снимки сжимаются на телефоне и уходят на ПК ---- */
  var shots = [];
  function shrink(file, maxSide) {
    return new Promise(function (resolve, reject) {
      var url = URL.createObjectURL(file);
      var img = new Image();
      img.onload = function () {
        var k = Math.min(1, maxSide / Math.max(img.naturalWidth, img.naturalHeight));
        var c = document.createElement("canvas");
        c.width = Math.round(img.naturalWidth * k); c.height = Math.round(img.naturalHeight * k);
        c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
        URL.revokeObjectURL(url);
        c.toBlob(function (b) { b ? resolve(b) : reject(new Error("shrink")); }, "image/jpeg", 0.88);
      };
      img.onerror = function () { URL.revokeObjectURL(url); reject(new Error("image")); };
      img.src = url;
    });
  }

  function viewScan(body) {
    var st = el("div", { class: "dim" });
    var count = el("div", { class: "dim" });
    var input = el("input", { type: "file", accept: "image/*", capture: "environment", style: "display:none" });
    var upd = function () { count.textContent = L.pages + ": " + shots.length; };
    input.addEventListener("change", function () {
      var f = input.files[0];
      if (!f) return;
      shrink(f, 2200).then(function (b) { shots.push(b); upd(); }).catch(function () { status(st, L.failed, "err"); });
      input.value = "";
    });
    var send = function (path, doneText) {
      if (!shots.length) return;
      var fd = new FormData();
      shots.forEach(function (b, i) { fd.append(path === "/scan/pdf" ? "files" : "file", b, "page" + (i + 1) + ".jpg"); });
      status(st, L.working);
      api("POST", path, fd).then(function (r) {
        status(st, doneText(r), "ok");
        shots = []; upd();
      }).catch(function () { status(st, L.failed, "err"); });
    };
    body.appendChild(el("h1", { text: L.scan }));
    body.appendChild(el("div", { class: "card" }, [
      el("p", { class: "dim", text: L.scanHint }),
      el("div", { class: "row" }, [
        el("button", { class: "pri", text: L.shoot, onclick: function () { input.click(); } }),
        el("button", { text: L.clearPages, onclick: function () { shots = []; upd(); } }), input
      ]),
      el("div", { style: "height:8px" }), count, el("div", { style: "height:8px" }),
      el("div", { class: "row" }, [
        el("button", { text: L.makePdf, onclick: function () { send("/scan/pdf", function () { return L.pdfDone; }); } }),
        el("button", { text: L.toTasks, onclick: function () {
          if (!shots.length) return;
          // чек-лист строится из первого кадра; остальные страницы — отдельными вызовами
          var all = shots.slice(); var total = 0; var chain = Promise.resolve();
          status(st, L.working);
          all.forEach(function (b) {
            chain = chain.then(function () {
              var fd = new FormData(); fd.append("file", b, "photo.jpg");
              return api("POST", "/scan/tasks", fd).then(function (r) { total += r.tasks || 0; });
            });
          });
          chain.then(function () { status(st, L.tasksDone + total, "ok"); shots = []; upd(); })
            .catch(function () { status(st, L.failed, "err"); });
        } })
      ]), st
    ]));
    upd();
  }

  function viewPlayer(body) {
    var info = el("div", { class: "card" });
    var pad = el("div", { class: "big" });
    var cmd = function (c, v) { api("POST", "/player/cmd", { cmd: c, value: v }).then(poll); };
    [["⏪ 10", "seek", -10], ["⏯", "toggle"], ["10 ⏩", "seek", 10], ["🔉", "volume", -0.1], ["🔇", "mute"], ["🔊", "volume", 0.1]].forEach(function (b) {
      pad.appendChild(el("button", { text: b[0], onclick: function () { cmd(b[1], b[2]); } }));
    });
    body.appendChild(el("h1", { text: L.player }));
    body.appendChild(info);
    body.appendChild(pad);
    function fmt(s) { s = Math.max(0, Math.floor(s)); return Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0"); }
    function poll() {
      api("GET", "/player").then(function (r) {
        clear(info);
        if (!r.state) { info.appendChild(el("div", { class: "dim", text: L.noPlayer })); return; }
        info.appendChild(el("div", { text: r.state.title || "—" }));
        info.appendChild(el("div", { class: "dim", text: (r.state.paused ? "⏸ " : "▶ ") + fmt(r.state.position) + " / " + fmt(r.state.duration) }));
      }).catch(function () { clear(info); info.textContent = L.offline; });
    }
    poll();
    timer = setInterval(poll, 2000);
  }

  render();
})();
`;

// MoonApp Web Clipper: страница или выделение → заметка в папке «Веб-клипы».
// Приложение получает ссылку moonapp://clip?... через протокол ОС; браузер
// перед открытием спрашивает подтверждение. Токены и порты приложения не нужны.
const MAX_TEXT = 6000;

function clipUrl(title, url, text) {
  const p = new URLSearchParams({
    title: String(title || "").slice(0, 200),
    url: String(url || ""),
    text: String(text || "").slice(0, MAX_TEXT),
  });
  return "moonapp://clip?" + p.toString();
}

async function send(tab, selection) {
  if (!tab || !/^https?:/i.test(tab.url || "")) return;
  let text = selection || "";
  if (!text) {
    try {
      const [r] = await chrome.scripting.executeScript({
        target: { tabId: tab.id },
        func: () => String(window.getSelection() || ""),
      });
      text = (r && r.result) || "";
    } catch (_) {
      /* страница без доступа к скриптам — сохраняем только ссылку */
    }
  }
  // Открываем протокол во временной вкладке и сразу закрываем её.
  const t = await chrome.tabs.create({ url: clipUrl(tab.title, tab.url, text), active: false });
  setTimeout(() => chrome.tabs.remove(t.id).catch(() => {}), 1500);
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.create({
    id: "moonapp-clip",
    title: "Сохранить в MoonApp",
    contexts: ["page", "selection"],
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId === "moonapp-clip") send(tab, info.selectionText || "");
});

chrome.action.onClicked.addListener((tab) => send(tab, ""));

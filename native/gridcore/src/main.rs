//! gridcore — ядро GridCraft без окна для интерфейса MoonApp («Таблицы»).
//!
//! Протокол: одна JSON-строка на запрос `{"id":1,"method":"…","params":{…}}` в stdin, одна строка
//! ответа `{"id":1,"ok":true,"result":…}` или `{"id":1,"ok":false,"error":"…"}` в stdout.
//!
//! Методы ядра (`engine.execute`, `engine.commands`, `document.inspect`, `sheet.read`, `cell.get`…)
//! отдаёт `gridcraft_mcp::Headless`; здесь добавлено то, что нужно собственному интерфейсу:
//!   view.state — книга, листы, выделение, строка формул, форматирование под ячейкой, настройки вида
//!   view.grid  — окно сетки: геометрия строк и столбцов, ячейки с готовым оформлением, объекты
//!   view.run   — команда ядра и сразу новое состояние (+ запросы команд к интерфейсу)
//!   view.image — байты картинки листа
//!   view.pos   — координаты строк и столбцов (для прокрутки)
#![deny(clippy::unwrap_used, clippy::expect_used)]

mod grid;
mod svg;

use std::io::{BufRead, Write};

use gridcraft_engine::UiRequest;
use gridcraft_mcp::{Backend, Headless};
use serde_json::{Value, json};

pub(crate) fn num(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(Value::as_f64)
}

/// Выполнить команду, оставив запросы команды к интерфейсу в сеансе (их заберёт `view.state`).
fn run(h: &mut Headless, id: &str, params: Value) -> Result<Value, String> {
    h.session.run(id, params)
}

fn handle(h: &mut Headless, method: &str, params: Value) -> Result<Value, String> {
    match method {
        "view.state" => Ok(grid::state(h)),
        "view.grid" => Ok(grid::window(h, &params)),
        "view.pos" => Ok(grid::pos(h, &params)),
        "view.filterInfo" => grid::filter_info(h, &params),
        "view.image" => grid::image(h, &params),
        "view.run" => {
            let id = params.get("command").and_then(Value::as_str).ok_or("missing `command`")?.to_string();
            let p = params.get("params").cloned().filter(|v| !v.is_null()).unwrap_or(json!({}));
            let result = run(h, &id, p)?;
            Ok(json!({"result": result, "state": grid::state(h)}))
        }
        // Настройки приложения (параметры Excel): `{userName?, autocomplete?, enterDirection?, defaultFont?, …}`.
        "view.prefs" => {
            let mut cur = serde_json::to_value(&h.session.prefs).map_err(|e| e.to_string())?;
            if let (Some(c), Some(p)) = (cur.as_object_mut(), params.as_object()) {
                for (k, v) in p {
                    c.insert(k.clone(), v.clone());
                }
            }
            h.session.prefs = serde_json::from_value(cur).map_err(|e| e.to_string())?;
            Ok(json!(h.session.prefs))
        }
        "view.requests" => Ok(json!(drain_requests(h))),
        // Сеанс держит ровно одну книгу: пустую «Book1», созданную при запуске, закрываем, когда открыта другая.
        "view.init" => {
            while h.session.documents().len() > 1 {
                h.session.close_document(0);
            }
            h.session.set_active(0);
            Ok(grid::state(h))
        }
        "ping" => Ok(json!({"pong": true})),
        other => {
            // Команды из `engine.execute` тоже могут просить интерфейс открыть диалог — сохраняем запросы.
            if other == "engine.execute" {
                let id = params.get("command").and_then(Value::as_str).unwrap_or("").to_string();
                let p = params.get("params").cloned().filter(|v| !v.is_null()).unwrap_or(json!({}));
                return run(h, &id, p);
            }
            h.call(other, params)
        }
    }
}

pub(crate) fn drain_requests(h: &mut Headless) -> Vec<Value> {
    h.session
        .take_ui_requests()
        .into_iter()
        .map(|r| match r {
            UiRequest::Dialog(name, params) => json!({"kind": "dialog", "name": name, "params": params}),
            UiRequest::Message(m) => json!({"kind": "message", "text": m}),
            UiRequest::EditCell(t) => json!({"kind": "edit", "text": t}),
            UiRequest::OpenUrl(u) => json!({"kind": "url", "url": u}),
        })
        .collect()
}

fn main() {
    let mut h = Headless::new();
    let stdin = std::io::stdin();
    let mut out = std::io::stdout().lock();
    for line in stdin.lock().lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        let reply = match serde_json::from_str::<Value>(&line) {
            Ok(req) => {
                let id = req.get("id").cloned().unwrap_or(Value::Null);
                let method = req.get("method").and_then(Value::as_str).unwrap_or("").to_string();
                let params = req.get("params").cloned().unwrap_or(json!({}));
                if method == "quit" {
                    break;
                }
                match handle(&mut h, &method, params) {
                    Ok(r) => json!({"id": id, "ok": true, "result": r}),
                    Err(e) => json!({"id": id, "ok": false, "error": e}),
                }
            }
            Err(e) => json!({"id": Value::Null, "ok": false, "error": format!("bad json: {e}")}),
        };
        if writeln!(out, "{reply}").is_err() || out.flush().is_err() {
            break;
        }
    }
}

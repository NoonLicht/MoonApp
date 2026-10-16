//! wordcore — ядро WordCraft без окна для интерфейса MoonApp.
//!
//! Протокол: одна JSON-строка на запрос `{"id":1,"method":"…","params":{…}}` в stdin, одна строка
//! ответа `{"id":1,"ok":true,"result":…}` или `{"id":1,"ok":false,"error":"…"}` в stdout.
//!
//! Методы ядра (`engine.execute`, `engine.commands`, `document.inspect`, `ui.render`) отдаёт
//! `wordcraft_mcp::Headless`; здесь добавлено то, что нужно собственному интерфейсу:
//!   view.state  — страницы, каретка, выделение, форматирование под кареткой, состояние отмены
//!   view.click  — клик по странице (`page`, `x`, `y` в пунктах), `extend`, `count` (2 — слово, 3 — абзац)
//!   view.key    — клавиша с модификаторами через раскладку горячих клавиш ядра
//!   view.type   — ввод текста в каретку
//!   view.run    — команда ядра и сразу новое состояние
#![deny(clippy::unwrap_used, clippy::expect_used)]

use std::io::{BufRead, Write};

use serde_json::{Value, json};
use wordcraft_doc::Pos;
use wordcraft_mcp::{Backend, Headless};

fn pos_value(p: &Pos) -> Value {
    serde_json::to_value(p).unwrap_or(Value::Null)
}

fn num(v: &Value, k: &str) -> Option<f64> {
    v.get(k).and_then(Value::as_f64)
}

fn flag(v: &Value, k: &str) -> bool {
    v.get(k).and_then(Value::as_bool).unwrap_or(false)
}

fn state(h: &mut Headless) -> Value {
    let layout = h.session.layout();
    let pages: Vec<Value> = layout
        .pages
        .iter()
        .map(|p| json!({"w": p.w, "h": p.h, "number": p.number, "body": {"x": p.body.x, "y": p.body.y, "w": p.body.w, "h": p.body.h}}))
        .collect();
    let sel = h.session.sel.clone();
    let caret = layout.caret(&sel.focus).map(|c| json!({"page": c.page, "x": c.x, "top": c.top, "height": c.height}));
    let (a, b) = sel.ordered();
    let rects: Vec<Value> = if sel.is_collapsed() {
        Vec::new()
    } else {
        layout
            .selection_rects(&h.session.doc, &a, &b, 0)
            .into_iter()
            .map(|(page, r)| json!({"page": page, "x": r.x, "y": r.y, "w": r.w, "h": r.h}))
            .collect()
    };
    let para = h.session.doc.para_at(&sel.focus).map(|p| serde_json::to_value(&p.props).unwrap_or(Value::Null));
    json!({
        "pages": pages,
        "caret": caret,
        "selection": {"collapsed": sel.is_collapsed(), "rects": rects, "anchor": pos_value(&sel.anchor), "focus": pos_value(&sel.focus), "text": h.session.selected_text()},
        "typing": serde_json::to_value(h.session.typing_props()).unwrap_or(Value::Null),
        "para": para,
        "canUndo": h.session.can_undo(),
        "canRedo": h.session.can_redo(),
        "undoLabel": h.session.undo_label(),
        "redoLabel": h.session.redo_label(),
        "dirty": h.session.dirty,
        "words": h.session.word_count(),
        "rev": h.session.rev(),
    })
}

fn run(h: &mut Headless, id: &str, params: Value) -> Result<Value, String> {
    h.call("engine.execute", json!({"command": id, "params": params}))
}

fn click(h: &mut Headless, p: &Value) -> Result<Value, String> {
    let page = num(p, "page").ok_or("missing `page`")? as usize;
    let (x, y) = (num(p, "x").ok_or("missing `x`")? as f32, num(p, "y").ok_or("missing `y`")? as f32);
    let layout = h.session.layout();
    let story = h.session.story();
    let pos = layout.hit(page, x, y, story).ok_or("no text there")?;
    let extend = flag(p, "extend");
    run(h, "caret.set", json!({"pos": pos_value(&pos), "extend": extend}))?;
    match num(p, "count").unwrap_or(1.0) as u32 {
        2 => {
            run(h, "select.word", json!({}))?;
        }
        3 => {
            run(h, "select.paragraph", json!({}))?;
        }
        _ => {}
    }
    Ok(state(h))
}

/// Клавиша → команда по раскладке ядра; Shift расширяет выделение у команд перемещения.
fn key(h: &mut Headless, p: &Value) -> Result<Value, String> {
    let name = p.get("key").and_then(Value::as_str).ok_or("missing `key`")?;
    let (ctrl, alt, shift) = (flag(p, "ctrl"), flag(p, "alt"), flag(p, "shift"));
    let combo = |with_shift: bool| {
        let mut s = String::new();
        if ctrl {
            s.push_str("Mod+");
        }
        if alt {
            s.push_str("Alt+");
        }
        if shift && with_shift {
            s.push_str("Shift+");
        }
        s.push_str(&if name.chars().count() == 1 { name.to_uppercase() } else { name.to_string() });
        s
    };
    let reg = h.session.registry.clone();
    if let Some(spec) = h.session.keymap.resolve(&reg, &combo(true)) {
        let id = spec.id;
        run(h, id, json!({}))?;
        return Ok(state(h));
    }
    if shift && let Some(spec) = h.session.keymap.resolve(&reg, &combo(false)) {
        let id = spec.id;
        if id.starts_with("caret.") {
            run(h, id, json!({"extend": true}))?;
        } else if id == "text.backspace" {
            run(h, id, json!({}))?;
        } else {
            return Err(format!("no command for {}", combo(true)));
        }
        return Ok(state(h));
    }
    Err(format!("no command for {}", combo(true)))
}

fn handle(h: &mut Headless, method: &str, params: Value) -> Result<Value, String> {
    match method {
        "view.state" => Ok(state(h)),
        "view.click" => click(h, &params),
        "view.key" => key(h, &params),
        "view.type" => {
            let text = params.get("text").and_then(Value::as_str).ok_or("missing `text`")?.to_string();
            run(h, "text.insert", json!({"text": text}))?;
            Ok(state(h))
        }
        "view.run" => {
            let id = params.get("command").and_then(Value::as_str).ok_or("missing `command`")?.to_string();
            let p = params.get("params").cloned().filter(|v| !v.is_null()).unwrap_or(json!({}));
            let result = run(h, &id, p)?;
            Ok(json!({"result": result, "state": state(h)}))
        }
        "ping" => Ok(json!({"pong": true})),
        other => h.call(other, params),
    }
}

fn main() {
    let mut h = Headless::default();
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

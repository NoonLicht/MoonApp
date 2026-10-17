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
use wordcraft_doc::{PartKind, Pos, StoryRef};
use wordcraft_engine::Session;
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

/// Выделенный рисунок, фигура, диаграмма или SmartArt: вид, размер, поворот, обтекание.
fn object_ctx(s: &mut Session) -> Value {
    use wordcraft_doc::para::InlineObject as O;
    let Some((_, o)) = wordcraft_engine::cmd::objects::selected(s) else { return Value::Null };
    let kind = match &o {
        O::Image { .. } => "picture",
        O::Graphic { graphic, .. } if graphic.chart.is_some() => "chart",
        O::Graphic { graphic, .. } if graphic.smart_art.is_some() => "smartArt",
        O::Graphic { .. } => "graphic",
        O::Shape { story: Some(_), .. } => "textBox",
        O::Shape { .. } => "shape",
        O::Group { .. } => "group",
        _ => "object",
    };
    let (w, h, float) = match o.frame() {
        Some((w, h, f)) => (w, h, serde_json::to_value(f).unwrap_or(Value::Null)),
        None => (0.0, 0.0, Value::Null),
    };
    let deg = o.frame().map(|(_, _, f)| f.spin().deg).unwrap_or(0.0);
    let (alt, crop) = match &o {
        O::Image { alt, crop, .. } => (alt.clone(), json!(crop)),
        O::Graphic { alt, .. } => (alt.clone(), Value::Null),
        _ => (String::new(), Value::Null),
    };
    let hint = s.page_hint;
    let rect = wordcraft_engine::cmd::objects::selected(s).and_then(|(pos, _)| {
        let layout = s.layout();
        layout.object(&pos, hint).map(|o| json!({"page": o.page, "x": o.rect.x, "y": o.rect.y, "w": o.rect.w, "h": o.rect.h, "floating": o.floating(), "behind": o.behind()}))
    });
    let canvas = wordcraft_engine::cmd::canvas::selected_canvas(s).is_some();
    let chart = wordcraft_engine::cmd::chart::selected_chart(s).map(|c| serde_json::to_value(&*c).unwrap_or(Value::Null));
    let smart = wordcraft_engine::cmd::smart_art::selected_smart_art(s).map(|c| serde_json::to_value(&*c).unwrap_or(Value::Null));
    let text_box = wordcraft_engine::cmd::objects::text_box_target(s)
        .and_then(|(_, id)| s.doc.parts.get(&id).map(|p| serde_json::to_value(p.body).unwrap_or(Value::Null)));
    json!({"kind": kind, "w": w, "h": h, "deg": deg, "rect": rect, "float": float, "alt": alt, "crop": crop, "canvas": canvas, "chart": chart, "smartArt": smart, "textBox": text_box})
}

/// Таблица под кареткой: оформление, размер текущих строки и столбца.
fn table_ctx(s: &mut Session) -> Value {
    let focus = s.sel.focus.clone();
    let Some((tp, r, c)) = focus.path.cell() else { return Value::Null };
    let story = focus.story;
    let Some(t) = s.doc.table(story, &tp) else { return Value::Null };
    let rows = t.rows.len();
    let cols = t.grid.len();
    let look = serde_json::to_value(t.props.look).unwrap_or(Value::Null);
    let style = t.props.style.clone();
    let row = t.rows.get(r).map(|x| x.props.clone()).unwrap_or_default();
    let stored_w = t.grid.get(t.grid_col(r, c)).copied();
    let (mut laid_w, mut row_h): (Option<f32>, Option<f32>) = (None, None);
    for pg in s.layout().pages.iter() {
        for it in pg.items.iter() {
            if let wordcraft_layout::Placed::Cell { rect, table, row: ri, cell, story: st, .. } = it
                && *table == tp
                && *st == story
                && *ri == r
            {
                row_h = Some(row_h.map_or(rect.h, |v: f32| v.min(rect.h)));
                if *cell == c {
                    laid_w = Some(rect.w);
                }
            }
        }
    }
    let exact = row.height_rule == wordcraft_doc::props::HeightRule::Exact;
    let height = row.height.or(row_h).unwrap_or(0.0);
    let width = laid_w.or(stored_w).unwrap_or(0.0);
    json!({"rows": rows, "cols": cols, "row": r, "col": c, "look": look, "style": style, "height": height, "width": width, "heightExact": exact})
}

/// Где сейчас каретка и какие контекстные вкладки нужны.
fn context(h: &mut Headless) -> Value {
    let s = &mut h.session;
    let part = match s.sel.focus.story {
        StoryRef::Body => "body",
        StoryRef::Part(id) => match s.doc.parts.get(&id).map(|p| p.kind) {
            Some(PartKind::Header) => "header",
            Some(PartKind::Footer) => "footer",
            Some(PartKind::Footnote) => "footnote",
            Some(PartKind::Endnote) => "endnote",
            Some(PartKind::Comment) => "comment",
            Some(PartKind::TextBox) => "textBox",
            None => "body",
        },
    };
    let object = object_ctx(s);
    let table = table_ctx(s);
    let section = serde_json::to_value(wordcraft_engine::cmd::page::sect(s)).unwrap_or(Value::Null);
    let margins = wordcraft_engine::cmd::page::margins_preset_at(s);
    let columns = wordcraft_engine::cmd::page::columns_preset_at(s);
    let text_dir = serde_json::to_value(wordcraft_engine::cmd::page::text_direction_at(s)).unwrap_or(Value::Null);
    json!({
        "section": section,
        "marginsPreset": margins,
        "columnsPreset": columns,
        "textDirection": text_dir,
        "part": part,
        "object": object,
        "table": table,
        "equation": s.math.is_some(),
        "painter": s.painter.is_some(),
        "recording": s.recording.is_some(),
    })
}

/// Настройки документа, которые нужны ленте и панелям.
fn doc_settings(s: &Session) -> Value {
    let st = &s.doc.settings;
    let hex = |c: &wordcraft_doc::Rgb| c.hex();
    json!({
        "trackChanges": st.track_changes,
        "evenOdd": st.even_odd_headers,
        "mirrorMargins": st.mirror_margins,
        "autoHyphenation": st.auto_hyphenation,
        "themeName": st.theme_name,
        "themeColors": st.theme_colors.iter().map(hex).collect::<Vec<_>>(),
        "majorFont": st.major_font,
        "minorFont": st.minor_font,
        "protection": st.protection,
        "defaultTab": st.default_tab,
        "watermark": st.watermark.is_some(),
        "pageColor": st.page_color.as_ref().map(hex),
        "language": s.editing_lang,
        "author": s.author,
        "bibStyle": s.bib_style,
        "mergeKind": s.merge.kind,
        "autosave": s.autosave,
    })
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
    let resolved = h.session.doc.para_at(&sel.focus).map(|p| h.session.doc.styles.resolve_para(&p.props));
    let para_resolved = resolved.as_ref().map(|r| {
        let mut v = serde_json::to_value(r).unwrap_or(Value::Null);
        let lists = wordcraft_engine::cmd::para::list_buttons(&h.session.doc, r.numbering);
        v["visualAlign"] = serde_json::to_value(r.align.visual(r.bidi)).unwrap_or(Value::Null);
        v["lists"] = json!({"bullets": lists.bullets, "numbering": lists.numbering, "multilevel": lists.multilevel});
        v
    });
    let format = h.session.run("format.state", &json!({})).unwrap_or(Value::Null);
    let view = serde_json::to_value(&h.session.view).unwrap_or(Value::Null);
    let settings = doc_settings(&h.session);
    let requests: Vec<Value> = h.session.ui_requests.drain(..).collect();
    let status = h.session.status.clone();
    let name = h.session.file_name.clone();
    let ctx = context(h);
    json!({
        "pages": pages,
        "caret": caret,
        "ctx": ctx,
        "paraResolved": para_resolved,
        "view": view,
        "settings": settings,
        "format": format,
        "requests": requests,
        "status": status,
        "fileName": name,
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

fn part_kind(s: &Session, st: StoryRef) -> Option<PartKind> {
    match st {
        StoryRef::Part(id) => s.doc.parts.get(&id).map(|p| p.kind),
        StoryRef::Body => None,
    }
}

/// Клик по странице: объект выбирается целиком, двойной клик в поле входит в колонтитул, а в тексте — выходит
/// из него, поле слева выделяет строку/абзац/документ, клик по формуле открывает её для правки.
fn click(h: &mut Headless, p: &Value) -> Result<Value, String> {
    let page = num(p, "page").ok_or("missing `page`")? as usize;
    let (x, y) = (num(p, "x").ok_or("missing `x`")? as f32, num(p, "y").ok_or("missing `y`")? as f32);
    let story = h.session.story();
    let extend = flag(p, "extend");
    let count = num(p, "count").unwrap_or(1.0) as u32;
    let print = h.session.view.mode == wordcraft_layout::ViewMode::Print && !h.session.view.read_mode;
    let layout = h.session.layout();

    // Двойной клик в верхнем или нижнем поле открывает колонтитул, в тексте — закрывает.
    let zone = if print { layout.header_footer_zone(page, y) } else { None };
    if count == 2 {
        let kind = part_kind(&h.session, story);
        let in_text_box = matches!(kind, Some(PartKind::TextBox));
        if let Some((_, header)) = zone
            && story == StoryRef::Body
        {
            run(h, if header { "insert.editHeader" } else { "insert.editFooter" }, json!({"page": page}))?;
            let layout = h.session.layout();
            if let Some(pos) = layout.hit(page, x, y, h.session.story()) {
                run(h, "caret.set", json!({"pos": pos_value(&pos)}))?;
            }
            return Ok(state(h));
        }
        if matches!(kind, Some(PartKind::Header | PartKind::Footer)) && !in_text_box && zone.is_none() {
            run(h, "insert.closeHeader", json!({}))?;
            let layout = h.session.layout();
            if let Some(pos) = layout.hit(page, x, y, StoryRef::Body) {
                run(h, "caret.set", json!({"pos": pos_value(&pos)}))?;
            }
            return Ok(state(h));
        }
    }

    // Рисунок, фигура или рамка под указателем выбираются целиком, как в Word.
    if !extend && count == 1 {
        if let Some(o) = layout.object_at_in(page, x, y, 2.0, story) {
            let pos = o.pos();
            let end = Pos { off: pos.off + wordcraft_doc::para::OBJ.len_utf8(), ..pos.clone() };
            run(h, "select.range", json!({"anchor": pos_value(&pos), "focus": pos_value(&end)}))?;
            return Ok(state(h));
        }
    }

    // Формула: клик ставит курсор в неё, клик в другом месте выходит из режима формулы.
    if !extend && let Some((at, inner)) = layout.equation_hit(page, x, y, story) {
        run(h, "caret.set", json!({"pos": pos_value(&at)}))?;
        run(h, "equation.edit", json!({"pos": serde_json::to_value(&inner).unwrap_or(Value::Null)}))?;
        return Ok(state(h));
    }
    if h.session.math.is_some() {
        let _ = run(h, "equation.exit", json!({}));
    }

    // Поле слева от текста: клик выделяет строку, двойной — абзац, тройной — документ.
    if story == StoryRef::Body
        && !extend
        && let Some(line) = layout.selection_bar_at(page, x, y)
    {
        run(h, "caret.set", json!({"pos": pos_value(&line)}))?;
        match count {
            2 => {
                run(h, "select.paragraph", json!({}))?;
            }
            3.. => {
                run(h, "select.all", json!({}))?;
            }
            _ => {
                run(h, "select.line", json!({"pos": pos_value(&line)}))?;
            }
        }
        return Ok(state(h));
    }

    // Сноска, надпись: клик внутри них правит их текст; в колонтитуле достижимы только его собственные надписи.
    let hf_part = matches!(part_kind(&h.session, story), Some(PartKind::Header | PartKind::Footer));
    let target = match layout.story_at(page, x, y) {
        Some(st) if matches!(part_kind(&h.session, st), Some(PartKind::Footnote | PartKind::Endnote)) => st,
        Some(st) if matches!(part_kind(&h.session, st), Some(PartKind::TextBox)) && !hf_part => st,
        Some(StoryRef::Body) if matches!(part_kind(&h.session, story), Some(PartKind::Footnote | PartKind::Endnote)) => StoryRef::Body,
        _ => story,
    };
    let Some(pos) = layout.hit(page, x, y, target) else {
        // Тело документа затемнено, пока правится колонтитул: клик мимо текста ничего не делает.
        return Ok(state(h));
    };
    run(h, "caret.set", json!({"pos": pos_value(&pos), "extend": extend}))?;
    match count {
        2 => {
            run(h, "select.word", json!({}))?;
        }
        3.. => {
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
    // Внутри формулы стрелки, Backspace, Delete, Enter и Escape идут в редактор формулы.
    if h.session.math.is_some() && !ctrl && !alt {
        let dir = match name {
            "Left" | "ArrowLeft" => Some("left"),
            "Right" | "ArrowRight" => Some("right"),
            "Up" | "ArrowUp" => Some("up"),
            "Down" | "ArrowDown" => Some("down"),
            "Home" => Some("home"),
            "End" => Some("end"),
            "Tab" => Some(if shift { "prev" } else { "next" }),
            _ => None,
        };
        if let Some(d) = dir {
            run(h, "equation.move", json!({"dir": d}))?;
            return Ok(state(h));
        }
        let command = match name {
            "Backspace" => Some("equation.backspace"),
            "Delete" => Some("equation.delete"),
            "Enter" => Some("equation.enter"),
            "Escape" => Some("equation.exit"),
            _ => None,
        };
        if let Some(c) = command {
            run(h, c, json!({}))?;
            return Ok(state(h));
        }
    }
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
            if h.session.math.is_some() {
                run(h, "equation.type", json!({"text": text}))?;
            } else {
                run(h, "text.insert", json!({"text": text}))?;
            }
            Ok(state(h))
        }
        "view.run" => {
            let id = params.get("command").and_then(Value::as_str).ok_or("missing `command`")?.to_string();
            let p = params.get("params").cloned().filter(|v| !v.is_null()).unwrap_or(json!({}));
            let result = run(h, &id, p)?;
            Ok(json!({"result": result, "state": state(h)}))
        }
        "view.clip" => Ok(json!({"text": h.session.clipboard_text.clone(), "html": h.session.clipboard_html.clone()})),
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

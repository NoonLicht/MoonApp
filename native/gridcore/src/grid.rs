//! Состояние книги и окно сетки для интерфейса: всё, что нужно, чтобы нарисовать лист как в Excel.

use std::collections::HashMap;

use gridcraft_engine::cf::{CfCache, CfLook};
use gridcraft_engine::core::{CellRef, MAX_COLS, MAX_ROWS, RangeRef, Value};
use gridcraft_engine::model::{Color, PatternType, Sheet, Style, Workbook};
use gridcraft_engine::numfmt::FormatColor;
use gridcraft_engine::{DocState, display, tables};
use gridcraft_mcp::Headless;
use serde_json::{Value as Json, json};

use crate::{drain_requests, num, svg};

const DEFAULT_TEXT: &str = "#000000";

fn hex3(c: [u8; 3]) -> String {
    format!("#{:02X}{:02X}{:02X}", c[0], c[1], c[2])
}

fn color_hex(c: Color, wb: &Workbook) -> Option<String> {
    c.hex(&wb.theme)
}

fn format_color(c: FormatColor) -> &'static str {
    match c {
        FormatColor::Black | FormatColor::Indexed(_) => "#000000",
        FormatColor::Blue => "#0000FF",
        FormatColor::Cyan => "#00FFFF",
        FormatColor::Green => "#008000",
        FormatColor::Magenta => "#FF00FF",
        FormatColor::Red => "#FF0000",
        FormatColor::White => "#FFFFFF",
        FormatColor::Yellow => "#FFFF00",
    }
}

fn enum_str<T: serde::Serialize>(v: &T) -> Json {
    serde_json::to_value(v).unwrap_or(Json::Null)
}

fn range_json(r: RangeRef) -> Json {
    json!({"r0": r.start.row, "c0": r.start.col, "r1": r.end.row, "c1": r.end.col, "a1": r.a1()})
}

fn cell_json(c: CellRef) -> Json {
    json!({"r": c.row, "c": c.col, "a1": c.a1()})
}

fn doc(h: &Headless) -> Option<&DocState> {
    h.session.active()
}

// ---------------------------------------------------------------- оформление

fn border_json(l: &gridcraft_engine::model::BorderLine, wb: &Workbook) -> Json {
    if l.is_none() {
        return Json::Null;
    }
    json!([l.style.width(), color_hex(l.color, wb).unwrap_or_else(|| DEFAULT_TEXT.into()), enum_str(&l.style)])
}

fn style_json(st: &Style, wb: &Workbook) -> Json {
    json!({
        "f": {
            "n": st.font.name,
            "z": st.font.size,
            "b": st.font.bold,
            "i": st.font.italic,
            "u": enum_str(&st.font.underline),
            "s": st.font.strike,
            "v": enum_str(&st.font.vert),
        },
        "a": {
            "h": enum_str(&st.align.h),
            "v": enum_str(&st.align.v),
            "w": st.align.wrap,
            "sh": st.align.shrink,
            "in": st.align.indent,
            "r": st.align.rotation,
        },
        "b": {
            "l": border_json(&st.borders.left, wb),
            "r": border_json(&st.borders.right, wb),
            "t": border_json(&st.borders.top, wb),
            "b": border_json(&st.borders.bottom, wb),
            "d": border_json(&st.borders.diag_down, wb),
            "u": border_json(&st.borders.diag_up, wb),
        },
    })
}

struct Look {
    style: Style,
    fill: Option<String>,
    text_color: Option<String>,
}

/// Вид ячейки: стиль, поверх него стиль таблицы и условное форматирование.
fn look(wb: &Workbook, si: usize, sh: &Sheet, c: CellRef, cf: &mut CfCache) -> (Look, Option<CfLook>) {
    let mut style = wb.styles.get(sh.style_id(c)).clone();
    if let Some(t) = sh.table_at(c) {
        style = tables::table_cell_style(wb, si, t, c);
    }
    let cfl = cf.look(wb, si, c);
    if let Some(l) = &cfl
        && let Some(st) = &l.style
    {
        if st.fill.pattern != PatternType::None {
            style.fill = st.fill;
        }
        if st.font.color != Color::Auto {
            style.font.color = st.font.color;
        }
        if st.font.bold {
            style.font.bold = true;
        }
        if st.font.italic {
            style.font.italic = true;
        }
        if st.font.underline != gridcraft_engine::model::Underline::None {
            style.font.underline = st.font.underline;
        }
        if st.font.strike {
            style.font.strike = true;
        }
        for (dst, src) in [
            (&mut style.borders.left, st.borders.left),
            (&mut style.borders.right, st.borders.right),
            (&mut style.borders.top, st.borders.top),
            (&mut style.borders.bottom, st.borders.bottom),
        ] {
            if !src.is_none() {
                *dst = src;
            }
        }
    }
    let mut fill = match style.fill.pattern {
        PatternType::None => None,
        PatternType::Solid => style.fill.fg.resolve(&wb.theme).map(hex3),
        _ => {
            // Узоры: смесь переднего и заднего цвета.
            let fg = style.fill.fg.resolve(&wb.theme).unwrap_or([0, 0, 0]);
            let bg = style.fill.bg.resolve(&wb.theme).unwrap_or([255, 255, 255]);
            Some(hex3([
                ((fg[0] as u16 + bg[0] as u16 * 3) / 4) as u8,
                ((fg[1] as u16 + bg[1] as u16 * 3) / 4) as u8,
                ((fg[2] as u16 + bg[2] as u16 * 3) / 4) as u8,
            ]))
        }
    };
    if let Some(l) = &cfl
        && let Some(rgb) = l.scale_fill
    {
        fill = Some(hex3(rgb));
    }
    let text_color = color_hex(style.font.color, wb);
    (Look { style, fill, text_color }, cfl)
}

/// Что показывает ячейка: число General сужается под ширину, остальное — по формату.
fn shown(wb: &Workbook, sh: &Sheet, c: CellRef, v: &Value, st: &Style, width_px: f32, char_w: f32) -> (String, Option<&'static str>, bool, Option<(char, usize)>) {
    if sh.show_formulas
        && let Some(f) = sh.cell(c).and_then(|x| x.formula.as_ref())
    {
        return (format!("={}", f.text), None, false, None);
    }
    if !sh.show_zeros && v.as_f64() == Some(0.0) {
        return (String::new(), None, false, None);
    }
    let code = st.num_fmt.as_str();
    if code == "checkbox" && matches!(v, Value::Bool(_) | Value::Empty) {
        return (String::new(), None, false, None);
    }
    if code == "General"
        && let Value::Number(n) = v
    {
        let max_chars = ((width_px - 4.0) / char_w).floor().max(1.0) as usize;
        return match gridcraft_engine::numfmt::format_general_fit(*n, max_chars.min(11)) {
            Some(t) => (t, None, true, None),
            None => ("#".repeat(max_chars.max(1)), None, true, None),
        };
    }
    let f = display::format(v, code, wb);
    (f.text, f.color.map(format_color), f.numeric, f.fill)
}

// ---------------------------------------------------------------- окно сетки

fn col_x(sh: &Sheet, c: u32) -> f64 {
    sh.col_left(c)
}

fn row_y(sh: &Sheet, r: u32) -> f64 {
    sh.row_top(r)
}

/// Последний видимый индекс, чей левый край не правее `x`.
fn visible_cols(sh: &Sheet, x0: f64, x1: f64, extra_after: u32) -> (u32, u32) {
    let c0 = sh.col_at(x0.max(0.0));
    let c1 = sh.col_at(x1.max(0.0)).saturating_add(extra_after).min(MAX_COLS - 1);
    (c0.min(MAX_COLS - 1), c1)
}

fn visible_rows(sh: &Sheet, y0: f64, y1: f64, extra_after: u32) -> (u32, u32) {
    let r0 = sh.row_at(y0.max(0.0));
    let r1 = sh.row_at(y1.max(0.0)).saturating_add(extra_after).min(MAX_ROWS - 1);
    (r0.min(MAX_ROWS - 1), r1)
}

fn push_cols(sh: &Sheet, a: u32, b: u32, out: &mut Vec<u32>) {
    for c in a..=b {
        if !sh.is_col_hidden(c) && sh.col_width(c) > 0.0 && !out.contains(&c) {
            out.push(c);
        }
    }
}

fn push_rows(sh: &Sheet, a: u32, b: u32, out: &mut Vec<u32>) {
    for r in a..=b {
        if !sh.is_row_hidden(r) && sh.row_height(r) > 0.0 && !out.contains(&r) {
            out.push(r);
        }
    }
}

fn spark_svg(wb: &Workbook, si: usize, sp: &gridcraft_engine::model::Sparkline, w: f32, h: f32) -> String {
    let vals: Vec<Option<f64>> = match gridcraft_engine::calc::evaluate(wb, si, sp.cell, &sp.source) {
        Value::Array(a) => a.data.iter().map(Value::as_f64).collect(),
        v => vec![v.as_f64()],
    };
    let col = sp.color.resolve(&wb.theme).unwrap_or([0x2B, 0x7C, 0xD3]);
    let prims = gridcraft_chart::render_sparkline(sp.kind, &vals, [col[0], col[1], col[2], 255], sp.markers, w, h);
    svg::prims_svg(&prims, w, h)
}

fn anchor_rect(sh: &Sheet, a: &gridcraft_engine::model::Anchor) -> Json {
    let x = col_x(sh, a.cell.col) + a.dx as f64;
    let y = row_y(sh, a.cell.row) + a.dy as f64;
    json!({"x": x, "y": y, "w": a.width, "h": a.height, "mode": enum_str(&a.mode)})
}

pub fn window(h: &mut Headless, p: &Json) -> Json {
    let Some(d) = doc(h) else { return json!({}) };
    let wb = d.wb.clone();
    let si = wb.active_sheet;
    let Some(sh) = wb.sheet(si) else { return json!({}) };
    let x = num(p, "x").unwrap_or(0.0);
    let y = num(p, "y").unwrap_or(0.0);
    let w = num(p, "w").unwrap_or(1200.0);
    let hh = num(p, "h").unwrap_or(800.0);
    let (fr, fc) = sh.freeze.unwrap_or((0, 0));
    // Заморожённые строки и столбцы занимают левый верхний угол: прокручиваемая часть начинается за ними.
    let fx = if fc > 0 { col_x(sh, fc) } else { 0.0 };
    let fy = if fr > 0 { row_y(sh, fr) } else { 0.0 };
    let (c0, c1) = visible_cols(sh, x + fx, x + fx + w, 8);
    let (r0, r1) = visible_rows(sh, y + fy, y + fy + hh, 3);
    let (c0, r0) = (c0.max(fc), r0.max(fr));
    let mut cols: Vec<u32> = Vec::new();
    let mut rows: Vec<u32> = Vec::new();
    if fc > 0 {
        push_cols(sh, 0, fc - 1, &mut cols);
    }
    if fr > 0 {
        push_rows(sh, 0, fr - 1, &mut rows);
    }
    // Одну строку и один столбец перед окном берём для границ и переполнения текста.
    push_cols(sh, c0.saturating_sub(1).max(fc), c1, &mut cols);
    push_rows(sh, r0.saturating_sub(1).max(fr), r1, &mut rows);
    let (cmin, cmax) = (cols.iter().copied().min().unwrap_or(0), cols.iter().copied().max().unwrap_or(0));
    let (rmin, rmax) = (rows.iter().copied().min().unwrap_or(0), rows.iter().copied().max().unwrap_or(0));
    let window = RangeRef::new(CellRef::new(rmin, cmin), CellRef::new(rmax, cmax));
    let colset: std::collections::HashSet<u32> = cols.iter().copied().collect();
    let rowset: std::collections::HashSet<u32> = rows.iter().copied().collect();
    let merges: Vec<RangeRef> = sh.merges.iter().copied().filter(|m| m.intersects(&window)).collect();
    let in_merge = |c: CellRef| merges.iter().find(|m| m.contains(c)).copied();
    // Спарклайны и кнопки фильтров по ячейкам.
    let mut sparks: HashMap<CellRef, &gridcraft_engine::model::Sparkline> = HashMap::new();
    for sp in &sh.sparklines {
        sparks.insert(sp.cell, sp);
    }
    let mut filters: HashMap<CellRef, bool> = HashMap::new();
    if let Some(af) = &sh.autofilter {
        for col in af.range.start.col..=af.range.end.col {
            let active = af.criteria.iter().any(|(o, _)| af.range.start.col + o == col);
            filters.insert(CellRef::new(af.range.start.row, col), active);
        }
    }
    for tb in &sh.tables {
        if tb.filter_button && tb.header_row {
            for col in tb.range.start.col..=tb.range.end.col {
                let active = tb.filter.iter().any(|(o, _)| tb.range.start.col + o == col);
                filters.insert(CellRef::new(tb.range.start.row, col), active);
            }
        }
    }
    let mut cf = CfCache::new();
    let mut styles: Vec<Json> = Vec::new();
    let mut style_ix: HashMap<String, usize> = HashMap::new();
    let mut cells: Vec<Json> = Vec::new();
    let mut want: Vec<CellRef> = Vec::new();
    for &r in &rows {
        for &c in &cols {
            want.push(CellRef::new(r, c));
        }
    }
    // Якоря объединённых ячеек вне окна тоже нужны (там лежит оформление).
    for m in &merges {
        if !colset.contains(&m.start.col) || !rowset.contains(&m.start.row) {
            want.push(m.start);
        }
    }
    let default_style = wb.styles.get(gridcraft_engine::model::StyleId::DEFAULT).clone();
    for c in want {
        let anchor = match in_merge(c) {
            Some(m) if m.start != c && colset.contains(&m.start.col) && rowset.contains(&m.start.row) => continue,
            Some(m) if m.start != c && !(c == m.start) => {
                // Ячейка внутри объединения, чей якорь вне окна: якорь отдельно, а здесь пропускаем.
                continue;
            }
            Some(m) => m.start,
            None => c,
        };
        let v = sh.value(anchor);
        let (lk, cfl) = look(wb.as_ref(), si, sh, anchor, &mut cf);
        let has_cell = sh.cell(anchor).is_some() || sh.spill.contains_key(&anchor);
        let styled = lk.fill.is_some()
            || lk.style != default_style
            || cfl.is_some()
            || sparks.contains_key(&anchor)
            || filters.contains_key(&anchor)
            || sh.cell_pictures.contains_key(&anchor)
            || in_merge(anchor).is_some();
        if !has_cell && !styled && !sh.comments.contains_key(&anchor) && !sh.hyperlinks.contains_key(&anchor) {
            continue;
        }
        let st = &lk.style;
        let size_px = st.font.size * 96.0 / 72.0;
        let char_w = (size_px * 0.53).max(1.0);
        let m = in_merge(anchor);
        let width_px = match m {
            Some(m) => (m.start.col..=m.end.col).map(|k| sh.col_width(k)).sum::<f32>(),
            None => sh.col_width(anchor.col),
        } - sh.filter_button_space(anchor);
        let hide = cfl.as_ref().is_some_and(|l| l.hide_value);
        let (mut text, ncolor, numeric, fill_char) = if v.is_empty() || hide { (String::new(), None, false, None) } else { shown(wb.as_ref(), sh, anchor, &v, st, width_px, char_w) };
        if let Some((ch, pos)) = fill_char
            && pos <= text.len()
            && text.is_char_boundary(pos)
        {
            // Повтор-заполнение формата `*x`: интерфейс растянет символ до ширины ячейки.
            text.insert(pos, '\u{0}');
            let _ = ch;
        }
        let sj = style_json(st, &wb).to_string();
        let sidx = *style_ix.entry(sj.clone()).or_insert_with(|| {
            styles.push(serde_json::from_str(&sj).unwrap_or(Json::Null));
            styles.len() - 1
        });
        let mut o = serde_json::Map::new();
        o.insert("r".into(), json!(anchor.row));
        o.insert("c".into(), json!(anchor.col));
        o.insert("s".into(), json!(sidx));
        if !text.is_empty() {
            o.insert("t".into(), json!(text));
        }
        if let Some((ch, _)) = fill_char {
            o.insert("fc".into(), json!(ch.to_string()));
        }
        let kind = match &v {
            Value::Number(_) => "n",
            Value::Bool(_) => "b",
            Value::Error(_) => "e",
            Value::Text(_) => "s",
            _ => "",
        };
        if !kind.is_empty() {
            o.insert("k".into(), json!(kind));
        }
        if numeric {
            o.insert("n".into(), json!(1));
        }
        let tc = ncolor.map(String::from).or_else(|| lk.text_color.clone());
        if let Some(tc) = tc
            && tc != DEFAULT_TEXT
        {
            o.insert("tc".into(), json!(tc));
        }
        if let Some(f) = &lk.fill {
            o.insert("fl".into(), json!(f));
        }
        if let Some(l) = &cfl {
            if let Some((frac, rgb, grad)) = l.bar {
                o.insert("bar".into(), json!([frac, hex3(rgb), grad]));
            }
            if let Some((set, idx)) = &l.icon {
                o.insert("ic".into(), json!([set, idx, gridcraft_engine::cf::icon_count(set)]));
            }
        }
        if st.num_fmt.as_str() == "checkbox" && matches!(v, Value::Bool(_) | Value::Empty) {
            o.insert("ck".into(), json!(if v == Value::Bool(true) { 1 } else { 0 }));
        }
        if sh.cell_pictures.contains_key(&anchor) {
            o.insert("pic".into(), json!(true));
        }
        if let Some(m) = m {
            o.insert("m".into(), json!([m.end.row - m.start.row + 1, m.end.col - m.start.col + 1]));
        }
        if let Some(active) = filters.get(&anchor) {
            o.insert("flt".into(), json!(if *active { 2 } else { 1 }));
        }
        if let Some(sp) = sparks.get(&anchor) {
            let (ww, hh) = (sh.col_width(anchor.col) - 6.0, sh.row_height(anchor.row) - 6.0);
            o.insert("sp".into(), json!(spark_svg(&wb, si, sp, ww.max(4.0), hh.max(4.0))));
        }
        if sh.comments.contains_key(&anchor) {
            o.insert("cm".into(), json!(1));
        }
        if sh.hyperlinks.contains_key(&anchor) {
            o.insert("lk".into(), json!(1));
        }
        cells.push(Json::Object(o));
    }
    let col_list: Vec<Json> = cols.iter().map(|&c| json!([c, col_x(sh, c), sh.col_width(c)])).collect();
    let row_list: Vec<Json> = rows.iter().map(|&r| json!([r, row_y(sh, r), sh.row_height(r)])).collect();
    // Плавающие объекты.
    let mut charts: Vec<Json> = Vec::new();
    for ch in &sh.charts {
        let data = gridcraft_chart::resolve(&wb, si, ch);
        let prims = gridcraft_chart::render(ch, &data, ch.anchor.width, ch.anchor.height, &gridcraft_chart::ApproxMeasure);
        let mut o = anchor_rect(sh, &ch.anchor);
        o["id"] = json!(ch.id);
        o["svg"] = json!(svg::prims_svg(&prims, ch.anchor.width, ch.anchor.height));
        o["kind"] = enum_str(&ch.kind);
        o["title"] = json!(ch.title);
        charts.push(o);
    }
    let images: Vec<Json> = sh
        .images
        .iter()
        .map(|im| {
            let mut o = anchor_rect(sh, &im.anchor);
            o["id"] = json!(im.id);
            o["mime"] = json!(im.mime);
            o["alt"] = json!(im.alt);
            o["size"] = json!(im.data.len());
            o
        })
        .collect();
    let shapes: Vec<Json> = sh
        .shapes
        .iter()
        .map(|s| {
            let mut o = anchor_rect(sh, &s.anchor);
            o["id"] = json!(s.id);
            o["kind"] = enum_str(&s.kind);
            o["fill"] = json!(color_hex(s.fill, &wb));
            o["line"] = json!(color_hex(s.line, &wb));
            o["text"] = json!(s.text);
            o["fmt"] = enum_str(&s.format);
            if let Some(c) = s.format.text_color {
                o["textColor"] = json!(color_hex(c, &wb));
            }
            o
        })
        .collect();
    let slicers: Vec<Json> = sh
        .slicers
        .iter()
        .map(|s| {
            let mut o = anchor_rect(sh, &s.anchor);
            o["id"] = json!(s.id);
            o["caption"] = json!(s.caption);
            o["table"] = json!(s.table);
            o["column"] = json!(s.column);
            o["columns"] = json!(s.columns);
            o["selected"] = json!(s.selected);
            o
        })
        .collect();
    json!({
        "sheet": si,
        "cols": col_list,
        "rows": row_list,
        "styles": styles,
        "cells": cells,
        "merges": merges.iter().map(|m| range_json(*m)).collect::<Vec<_>>(),
        "charts": charts,
        "images": images,
        "shapes": shapes,
        "slicers": slicers,
        "freeze": [fr, fc],
        "frozenX": fx,
        "frozenY": fy,
        "revision": d.revision,
    })
}

/// Координаты строк и столбцов (для размеров полос прокрутки и перехода к ячейке).
pub fn pos(h: &Headless, p: &Json) -> Json {
    let Some(sh) = doc(h).and_then(|d| d.wb.active()) else { return json!({}) };
    let rows: Vec<u32> = p.get("rows").and_then(Json::as_array).map(|a| a.iter().filter_map(|v| v.as_u64()).map(|v| v as u32).collect()).unwrap_or_default();
    let cols: Vec<u32> = p.get("cols").and_then(Json::as_array).map(|a| a.iter().filter_map(|v| v.as_u64()).map(|v| v as u32).collect()).unwrap_or_default();
    let at_x: Vec<f64> = p.get("atX").and_then(Json::as_array).map(|a| a.iter().filter_map(Json::as_f64).collect()).unwrap_or_default();
    let at_y: Vec<f64> = p.get("atY").and_then(Json::as_array).map(|a| a.iter().filter_map(Json::as_f64).collect()).unwrap_or_default();
    json!({
        "rows": rows.iter().map(|&r| json!([r, row_y(sh, r), sh.row_height(r)])).collect::<Vec<_>>(),
        "cols": cols.iter().map(|&c| json!([c, col_x(sh, c), sh.col_width(c)])).collect::<Vec<_>>(),
        "rowAt": at_y.iter().map(|&y| sh.row_at(y)).collect::<Vec<_>>(),
        "colAt": at_x.iter().map(|&x| sh.col_at(x)).collect::<Vec<_>>(),
        "total": [col_x(sh, MAX_COLS.min(16_384)), row_y(sh, MAX_ROWS)],
    })
}

pub fn image(h: &Headless, p: &Json) -> Result<Json, String> {
    let sh = doc(h).and_then(|d| d.wb.active()).ok_or("no sheet")?;
    let id = p.get("id").and_then(Json::as_u64).ok_or("missing `id`")? as u32;
    let im = sh.images.iter().find(|i| i.id == id).ok_or("no such picture")?;
    Ok(json!({"mime": im.mime, "base64": gridcraft_engine::io::base64_encode(&im.data)}))
}

// ---------------------------------------------------------------- состояние

fn sheet_ctx(wb: &Workbook, si: usize, sh: &Sheet, active: CellRef) -> Json {
    let table = sh.table_at(active).map(|t| {
        let col = (active.col - t.range.start.col) as usize;
        json!({
            "name": t.name, "range": range_json(t.range), "style": t.style, "header": t.header_row, "totals": t.totals_row,
            "bandedRows": t.banded_rows, "bandedCols": t.banded_cols, "firstCol": t.first_col, "lastCol": t.last_col,
            "filterButton": t.filter_button, "column": t.columns.get(col).map(|c| c.name.clone()),
        })
    });
    let pivot = sh.pivots.iter().find(|p| p.last_range.is_some_and(|r| r.contains(active))).map(|p| json!({"id": p.id, "name": p.name}));
    let validation = sh.validations.iter().find(|d| d.ranges.iter().any(|r| r.contains(active))).map(|dv| {
        let items = if dv.kind == gridcraft_engine::model::ValidationKind::List { gridcraft_engine::cmd::data::list_items(wb, si, dv) } else { vec![] };
        json!({
            "kind": enum_str(&dv.kind), "dropdown": dv.in_cell_dropdown, "items": items, "showInput": dv.show_input,
            "inputTitle": dv.input_title, "inputMessage": dv.input_message,
        })
    });
    let comment = sh.comments.get(&active).map(|c| json!({"author": c.author, "text": c.text, "threaded": c.threaded, "replies": c.replies, "resolved": c.resolved}));
    let link = sh.hyperlinks.get(&active).map(|l| json!({"target": l.target, "tooltip": l.tooltip, "external": l.external}));
    let filtered = sh.autofilter.is_some();
    json!({
        "table": table, "pivot": pivot, "validation": validation, "comment": comment, "link": link,
        "autofilter": filtered, "protected": sh.is_protected(), "merged": sh.merge_at(active).map(range_json),
        "spill": sh.spill_ranges.iter().find(|(_, r)| r.contains(active)).map(|(a, r)| json!({"anchor": a.a1(), "range": range_json(*r)})),
    })
}

fn objects_summary(sh: &Sheet) -> Json {
    json!({
        "charts": sh.charts.iter().map(|c| json!({"id": c.id, "title": c.title, "kind": enum_str(&c.kind)})).collect::<Vec<_>>(),
        "images": sh.images.iter().map(|c| json!({"id": c.id, "alt": c.alt})).collect::<Vec<_>>(),
        "shapes": sh.shapes.iter().map(|c| json!({"id": c.id, "kind": enum_str(&c.kind), "text": c.text})).collect::<Vec<_>>(),
        "slicers": sh.slicers.iter().map(|c| json!({"id": c.id, "caption": c.caption})).collect::<Vec<_>>(),
        "comments": sh.comments.iter().map(|(c, cm)| json!({"cell": c.a1(), "r": c.row, "c": c.col, "author": cm.author, "text": cm.text, "threaded": cm.threaded, "replies": cm.replies, "resolved": cm.resolved, "visible": cm.visible})).collect::<Vec<_>>(),
    })
}

pub fn state(h: &mut Headless) -> Json {
    let requests = drain_requests(h);
    let s = &h.session;
    let Some(d) = s.active() else { return json!({"open": false, "requests": requests}) };
    let wb = d.wb.clone();
    let si = wb.active_sheet;
    let Some(sh) = wb.sheet(si) else { return json!({"open": false, "requests": requests}) };
    let sel = &d.selection;
    let active = sel.active;
    let (lk, _) = look(wb.as_ref(), si, sh, active, &mut CfCache::new());
    let st = &lk.style;
    let v = sh.value(active);
    let editable = display::edit_text(&wb, sh, active);
    let hidden_formula = display::formula_hidden(&wb, sh, active);
    let bar = if hidden_formula { String::new() } else { editable };
    let name_box = wb
        .names
        .iter()
        .find(|n| n.scope.is_none() && !n.hidden && n.formula.trim_start_matches('=') == format!("'{}'!{}", sh.name, sel.current().a1()))
        .map(|n| n.name.clone());
    let sheets: Vec<Json> = wb
        .sheets
        .iter()
        .enumerate()
        .map(|(i, s)| {
            json!({
                "i": i, "name": s.name, "color": s.tab_color.and_then(|c| color_hex(c, &wb)),
                "visibility": enum_str(&s.visibility), "protected": s.is_protected(),
            })
        })
        .collect();
    let used = sh.used_range();
    let fmt = json!({
        "font": st.font.name, "size": st.font.size, "bold": st.font.bold, "italic": st.font.italic,
        "underline": enum_str(&st.font.underline), "strike": st.font.strike, "vert": enum_str(&st.font.vert),
        "color": color_hex(st.font.color, &wb), "fill": lk.fill, "numFmt": st.num_fmt.as_str(),
        "h": enum_str(&st.align.h), "v": enum_str(&st.align.v), "wrap": st.align.wrap, "shrink": st.align.shrink,
        "indent": st.align.indent, "rotation": st.align.rotation,
        "locked": st.protection.locked, "hiddenFormula": st.protection.hidden,
        "borders": style_json(st, &wb)["b"].clone(),
    });
    let stats = {
        let mut sum = 0.0;
        let (mut count, mut nums) = (0u64, 0u64);
        let (mut min, mut max) = (f64::INFINITY, f64::NEG_INFINITY);
        for r in &sel.ranges {
            let Some(r) = sh.used_range().and_then(|u| r.intersection(&u)) else { continue };
            for c in r.iter().take(1_000_000) {
                if sh.is_row_hidden(c.row) || sh.is_col_hidden(c.col) {
                    continue;
                }
                let v = sh.value(c);
                if v.is_empty() {
                    continue;
                }
                count += 1;
                if let Value::Number(n) = v {
                    nums += 1;
                    sum += n;
                    min = min.min(n);
                    max = max.max(n);
                }
            }
        }
        json!({"count": count, "nums": nums, "sum": sum, "min": if nums > 0 { json!(min) } else { Json::Null }, "max": if nums > 0 { json!(max) } else { Json::Null }, "avg": if nums > 0 { json!(sum / nums as f64) } else { Json::Null }})
    };
    json!({
        "open": true,
        "doc": {"title": d.display_title(), "path": d.path, "dirty": d.is_dirty(), "uid": d.uid, "revision": d.revision},
        "sheets": sheets,
        "active": si,
        "sel": {
            "active": cell_json(active), "anchor": cell_json(sel.anchor),
            "ranges": sel.ranges.iter().map(|r| range_json(*r)).collect::<Vec<_>>(), "a1": sel.a1(),
            "wholeRows": sel.current().is_full_rows(), "wholeCols": sel.current().is_full_cols(),
        },
        "bar": {"text": bar, "formula": sh.cell(active).is_some_and(|c| c.formula.is_some()) && !hidden_formula, "kind": match &v { Value::Number(_) => "n", Value::Bool(_) => "b", Value::Error(_) => "e", Value::Text(_) => "s", _ => "" }},
        "nameBox": name_box.unwrap_or_else(|| if sel.is_single_cell() { active.a1() } else { sel.current().a1() }),
        "names": wb.names.iter().filter(|n| !n.hidden && (n.scope.is_none() || n.scope == Some(si))).map(|n| json!({"name": n.name, "formula": n.formula})).collect::<Vec<_>>(),
        "undo": d.undo.iter().rev().take(20).map(|e| e.label.clone()).collect::<Vec<_>>(),
        "redo": d.redo.iter().rev().take(20).map(|e| e.label.clone()).collect::<Vec<_>>(),
        "canUndo": !d.undo.is_empty(), "canRedo": !d.redo.is_empty(),
        "view": {
            "zoom": sh.zoom, "gridlines": sh.show_gridlines, "headings": sh.show_headings, "formulas": sh.show_formulas,
            "zeros": sh.show_zeros, "rtl": sh.right_to_left, "freeze": sh.freeze.map(|(r, c)| json!([r, c])),
            "mode": sh.view.as_str(), "formulaBar": s.prefs.formula_bar, "ruler": !s.hide_ruler,
            "tabColor": sh.tab_color.and_then(|c| color_hex(c, &wb)),
        },
        "used": used.map(range_json),
        "maxRows": MAX_ROWS, "maxCols": MAX_COLS,
        "format": fmt,
        "stats": stats,
        "ctx": sheet_ctx(&wb, si, sh, active),
        "objects": objects_summary(sh),
        "mode": enum_str(&s.mode),
        "painter": s.format_painter.is_some(),
        "recording": s.recording.is_some(),
        "clipboard": s.clipboard.as_ref().filter(|c| c.doc_uid == d.uid && c.wb.active_sheet == si || c.doc_uid == d.uid).map(|c| json!({"range": range_json(c.range), "sheet": c.sheet, "cut": c.cut, "areas": c.areas.iter().map(|a| range_json(*a)).collect::<Vec<_>>()})),
        "theme": {"colors": wb.theme.colors.iter().map(|c| format!("#{:06X}", c & 0xFFFFFF)).collect::<Vec<_>>(), "name": wb.theme.name, "major": wb.theme.major_font, "minor": wb.theme.minor_font},
        "calc": {"mode": enum_str(&wb.calc.mode), "iterative": wb.calc.iterative},
        "prefs": enum_str(&s.prefs),
        "protectedStructure": wb.protected_structure,
        "docs": s.documents().iter().map(|d| json!({"title": d.display_title(), "dirty": d.is_dirty()})).collect::<Vec<_>>(),
        "requests": requests,
    })
}

/// Данные для выпадающего меню фильтра в ячейке заголовка: диапазон, значения столбца и их состояние.
pub fn filter_info(h: &Headless, p: &Json) -> Result<Json, String> {
    let d = doc(h).ok_or("no document")?;
    let wb = &d.wb;
    let sh = wb.active().ok_or("no sheet")?;
    let r = num(p, "r").ok_or("missing `r`")? as u32;
    let c = num(p, "c").ok_or("missing `c`")? as u32;
    let at = CellRef::new(r, c);
    let (range, criteria, header) = if let Some(af) = sh.autofilter.as_ref().filter(|af| af.range.start.row == r && af.range.contains(at)) {
        (af.range, af.criteria.clone(), true)
    } else if let Some(t) = sh.tables.iter().find(|t| t.header_row && t.range.start.row == r && t.range.contains(at)) {
        let mut rg = t.range;
        if t.totals_row && rg.end.row > rg.start.row {
            rg.end.row -= 1;
        }
        (rg, t.filter.clone(), true)
    } else {
        return Err("no filter button here".into());
    };
    let _ = header;
    let off = c - range.start.col;
    let crit = criteria.iter().find(|(o, _)| *o == off).map(|(_, k)| k.clone());
    let (selected_vals, sel_blanks): (Option<Vec<String>>, bool) = match &crit {
        Some(gridcraft_engine::model::FilterCriterion::Values { values, blanks }) => (Some(values.iter().map(|v| v.to_lowercase()).collect()), *blanks),
        _ => (None, true),
    };
    let mut counts: Vec<(String, u32)> = Vec::new();
    let mut index: HashMap<String, usize> = HashMap::new();
    let mut blanks = 0u32;
    for row in (range.start.row + 1)..=range.end.row {
        let cell = CellRef::new(row, c);
        let v = sh.value(cell);
        if v.is_empty() {
            blanks += 1;
            continue;
        }
        let text = display::value_text(wb, sh, cell);
        if let Some(&i) = index.get(&text) {
            counts[i].1 += 1;
        } else if counts.len() < 5000 {
            index.insert(text.clone(), counts.len());
            counts.push((text, 1));
        }
    }
    counts.sort_by(|a, b| gridcraft_engine::core::value::compare_text(&a.0, &b.0));
    let custom = !matches!(crit, None | Some(gridcraft_engine::model::FilterCriterion::Values { .. }));
    Ok(json!({
        "range": range_json(range),
        "column": c,
        "offset": off,
        "values": counts.iter().map(|(t, n)| json!({"text": t, "count": n, "selected": selected_vals.as_ref().is_none_or(|s| s.contains(&t.to_lowercase()))})).collect::<Vec<_>>(),
        "blanks": {"count": blanks, "selected": sel_blanks},
        "active": crit.is_some(),
        "custom": custom,
        "criterion": crit.map(|k| serde_json::to_value(&k).unwrap_or(Json::Null)),
    }))
}

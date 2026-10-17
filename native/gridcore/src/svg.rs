//! Примитивы диаграмм и спарклайнов GridCraft → строка SVG.

use gridcraft_chart::{HAlign, Prim, Rgba, VAlign};
use std::fmt::Write;

fn col(c: Rgba) -> String {
    format!("rgb({},{},{})", c[0], c[1], c[2])
}

fn opacity(c: Rgba) -> String {
    if c[3] == 255 { String::new() } else { format!(" opacity=\"{:.3}\"", c[3] as f32 / 255.0) }
}

fn fill_attr(f: Option<Rgba>) -> String {
    match f {
        Some(c) => format!(" fill=\"{}\" fill-opacity=\"{:.3}\"", col(c), c[3] as f32 / 255.0),
        None => " fill=\"none\"".to_string(),
    }
}

fn stroke_attr(s: Option<(Rgba, f32)>) -> String {
    match s {
        Some((c, w)) => format!(" stroke=\"{}\" stroke-opacity=\"{:.3}\" stroke-width=\"{:.2}\"", col(c), c[3] as f32 / 255.0, w),
        None => String::new(),
    }
}

fn esc(s: &str) -> String {
    s.replace('&', "&amp;").replace('<', "&lt;").replace('>', "&gt;")
}

/// Точка на окружности: угол от 12 часов по часовой стрелке.
fn polar(cx: f32, cy: f32, r: f32, a: f32) -> (f32, f32) {
    (cx + r * a.sin(), cy - r * a.cos())
}

pub fn prims_svg(prims: &[Prim], w: f32, h: f32) -> String {
    let mut s = String::new();
    let _ = write!(s, "<svg xmlns=\"http://www.w3.org/2000/svg\" viewBox=\"0 0 {w:.1} {h:.1}\" width=\"{w:.1}\" height=\"{h:.1}\" font-family=\"Segoe UI, Calibri, Arial, sans-serif\">");
    for p in prims {
        match p {
            Prim::Rect { x, y, w, h, fill, stroke, radius } => {
                let _ = write!(
                    s,
                    "<rect x=\"{x:.2}\" y=\"{y:.2}\" width=\"{w:.2}\" height=\"{h:.2}\" rx=\"{radius:.2}\"{}{}/>",
                    fill_attr(*fill),
                    stroke_attr(*stroke)
                );
            }
            Prim::Line { pts, color, width, dash } => {
                if pts.len() < 2 {
                    continue;
                }
                let d: Vec<String> = pts.iter().map(|p| format!("{:.2},{:.2}", p[0], p[1])).collect();
                let _ = write!(
                    s,
                    "<polyline points=\"{}\" fill=\"none\" stroke=\"{}\" stroke-width=\"{width:.2}\" stroke-linejoin=\"round\" stroke-linecap=\"round\"{}{}/>",
                    d.join(" "),
                    col(*color),
                    opacity(*color).replace("opacity", "stroke-opacity"),
                    if *dash { " stroke-dasharray=\"4 3\"" } else { "" }
                );
            }
            Prim::Polygon { pts, fill, stroke } => {
                let d: Vec<String> = pts.iter().map(|p| format!("{:.2},{:.2}", p[0], p[1])).collect();
                let _ = write!(s, "<polygon points=\"{}\"{}{}/>", d.join(" "), fill_attr(Some(*fill)), stroke_attr(*stroke));
            }
            Prim::Wedge { cx, cy, r_outer, r_inner, a0, a1, fill, stroke } => {
                let full = (a1 - a0).abs() >= std::f32::consts::TAU - 1e-4;
                let large = if (a1 - a0).abs() > std::f32::consts::PI { 1 } else { 0 };
                let d = if full {
                    // Полный круг или кольцо: две полуокружности.
                    let (x0, y0) = polar(*cx, *cy, *r_outer, 0.0);
                    let (x1, y1) = polar(*cx, *cy, *r_outer, std::f32::consts::PI);
                    let mut d = format!("M{x0:.2} {y0:.2}A{r_outer:.2} {r_outer:.2} 0 1 1 {x1:.2} {y1:.2}A{r_outer:.2} {r_outer:.2} 0 1 1 {x0:.2} {y0:.2}Z");
                    if *r_inner > 0.0 {
                        let (i0x, i0y) = polar(*cx, *cy, *r_inner, 0.0);
                        let (i1x, i1y) = polar(*cx, *cy, *r_inner, std::f32::consts::PI);
                        let _ = write!(d, "M{i0x:.2} {i0y:.2}A{r_inner:.2} {r_inner:.2} 0 1 0 {i1x:.2} {i1y:.2}A{r_inner:.2} {r_inner:.2} 0 1 0 {i0x:.2} {i0y:.2}Z");
                    }
                    d
                } else {
                    let (ox0, oy0) = polar(*cx, *cy, *r_outer, *a0);
                    let (ox1, oy1) = polar(*cx, *cy, *r_outer, *a1);
                    if *r_inner > 0.0 {
                        let (ix1, iy1) = polar(*cx, *cy, *r_inner, *a1);
                        let (ix0, iy0) = polar(*cx, *cy, *r_inner, *a0);
                        format!("M{ox0:.2} {oy0:.2}A{r_outer:.2} {r_outer:.2} 0 {large} 1 {ox1:.2} {oy1:.2}L{ix1:.2} {iy1:.2}A{r_inner:.2} {r_inner:.2} 0 {large} 0 {ix0:.2} {iy0:.2}Z")
                    } else {
                        format!("M{cx:.2} {cy:.2}L{ox0:.2} {oy0:.2}A{r_outer:.2} {r_outer:.2} 0 {large} 1 {ox1:.2} {oy1:.2}Z")
                    }
                };
                let _ = write!(s, "<path d=\"{d}\" fill-rule=\"evenodd\"{}{}/>", fill_attr(Some(*fill)), stroke_attr(*stroke));
            }
            Prim::Circle { cx, cy, r, fill, stroke } => {
                let _ = write!(s, "<circle cx=\"{cx:.2}\" cy=\"{cy:.2}\" r=\"{r:.2}\"{}{}/>", fill_attr(*fill), stroke_attr(*stroke));
            }
            Prim::Text { x, y, text, size, color, bold, align, valign, rotation } => {
                let anchor = match align {
                    HAlign::Left => "start",
                    HAlign::Center => "middle",
                    HAlign::Right => "end",
                };
                let base = match valign {
                    VAlign::Top => "hanging",
                    VAlign::Middle => "central",
                    VAlign::Bottom => "text-after-edge",
                };
                let rot = if *rotation != 0.0 { format!(" transform=\"rotate({:.2} {x:.2} {y:.2})\"", rotation.to_degrees()) } else { String::new() };
                let _ = write!(
                    s,
                    "<text x=\"{x:.2}\" y=\"{y:.2}\" font-size=\"{size:.1}\" fill=\"{}\" text-anchor=\"{anchor}\" dominant-baseline=\"{base}\"{}{}{rot}>{}</text>",
                    col(*color),
                    if *bold { " font-weight=\"700\"" } else { "" },
                    opacity(*color).replace("opacity", "fill-opacity"),
                    esc(text)
                );
            }
        }
    }
    s.push_str("</svg>");
    s
}

/* Чистые операции над списком объектов: перенос, группы, слои, копирование. */
import {
  aabbOf,
  boundsOf,
  boxContains,
  center,
  corners,
  lineEnds,
  rotatePt,
  uid,
  unionBox,
  type Box,
  type Obj,
  type Pt,
} from "@/pages/myspace/canvas/model";

export const mapById = (objs: Obj[]): Map<string, Obj> => new Map(objs.map((o) => [o.id, o]));

/** Все потомки (дети рамок и групп, и их дети). */
export function descendants(objs: Obj[], id: string): Set<string> {
  const out = new Set<string>();
  let frontier = [id];
  while (frontier.length) {
    const next: string[] = [];
    for (const o of objs) {
      if (o.parent && frontier.includes(o.parent) && !out.has(o.id)) {
        out.add(o.id);
        next.push(o.id);
      }
    }
    frontier = next;
  }
  return out;
}

/** Выбранные вместе с потомками — то, что реально двигается. */
export function withChildren(objs: Obj[], ids: Iterable<string>): Set<string> {
  const out = new Set<string>(ids);
  for (const id of [...out]) for (const d of descendants(objs, id)) out.add(d);
  return out;
}

/** Самая верхняя группа, в которую входит объект: клик по ребёнку выбирает группу целиком. */
export function topGroupOf(objs: Obj[], id: string): string {
  const byId = mapById(objs);
  let cur = byId.get(id);
  let top = id;
  while (cur?.parent) {
    const p = byId.get(cur.parent);
    if (!p) break;
    if (p.type === "group") top = p.id;
    cur = p;
  }
  return top;
}

export function moveObjs(objs: Obj[], ids: Set<string>, dx: number, dy: number): Obj[] {
  if (dx === 0 && dy === 0) return objs;
  return objs.map((o) => {
    if (!ids.has(o.id)) return o;
    if (o.type === "line") {
      const mv = (a: Obj["from"]) =>
        a && !a.id ? { ...a, x: (a.x ?? 0) + dx, y: (a.y ?? 0) + dy } : a;
      return { ...o, from: mv(o.from), to: mv(o.to) };
    }
    return { ...o, x: o.x + dx, y: o.y + dy };
  });
}

/** Границы группы подгоняются под детей. */
export function fitGroups(objs: Obj[]): Obj[] {
  const byId = mapById(objs);
  let changed = false;
  const groups = objs.filter((o) => o.type === "group");
  // от вложенных к внешним
  const depth = (o: Obj) => {
    let d = 0;
    let c: Obj | undefined = o;
    while (c?.parent) {
      d++;
      c = byId.get(c.parent);
    }
    return d;
  };
  groups.sort((a, b) => depth(b) - depth(a));
  const next = new Map(byId);
  for (const g of groups) {
    const kids = objs.filter((o) => o.parent === g.id).map((o) => next.get(o.id) ?? o);
    const box = unionBox(kids.map((k) => boundsOf(k, next)));
    if (!box) continue;
    const cur = next.get(g.id) ?? g;
    if (cur.x !== box.x || cur.y !== box.y || cur.w !== box.w || cur.h !== box.h) {
      next.set(g.id, { ...cur, x: box.x, y: box.y, w: box.w, h: box.h });
      changed = true;
    }
  }
  return changed ? objs.map((o) => next.get(o.id) ?? o) : objs;
}

/** Пустые группы исчезают, одинокий ребёнок группы остаётся сам. */
export function pruneGroups(objs: Obj[]): Obj[] {
  let cur = objs;
  for (;;) {
    const counts = new Map<string, number>();
    for (const o of cur) if (o.parent) counts.set(o.parent, (counts.get(o.parent) ?? 0) + 1);
    const dead = cur.filter((o) => o.type === "group" && (counts.get(o.id) ?? 0) < 2);
    if (dead.length === 0) return cur;
    const ids = new Set(dead.map((d) => d.id));
    const parentOf = new Map(dead.map((d) => [d.id, d.parent ?? null]));
    cur = cur
      .filter((o) => !ids.has(o.id))
      .map((o) => (o.parent && ids.has(o.parent) ? { ...o, parent: parentOf.get(o.parent) } : o));
  }
}

export function groupObjs(objs: Obj[], ids: string[]): { objs: Obj[]; id: string } | null {
  const members = objs.filter((o) => ids.includes(o.id) && o.type !== "line" && !o.locked);
  if (members.length < 2) return null;
  const byId = mapById(objs);
  const box = unionBox(members.map((m) => boundsOf(m, byId)));
  if (!box) return null;
  const gid = uid();
  const parent = members[0].parent ?? null;
  const sameParent = members.every((m) => (m.parent ?? null) === parent);
  const group: Obj = {
    id: gid,
    type: "group",
    x: box.x,
    y: box.y,
    w: box.w,
    h: box.h,
    rot: 0,
    name: "Группа",
    parent: sameParent ? parent : null,
  };
  const set = new Set(members.map((m) => m.id));
  const top = Math.max(...objs.map((o, i) => (set.has(o.id) ? i : -1)));
  const out: Obj[] = [];
  objs.forEach((o, i) => {
    out.push(set.has(o.id) ? { ...o, parent: gid } : o);
    if (i === top) out.push(group);
  });
  return { objs: out, id: gid };
}

export function ungroupObjs(objs: Obj[], ids: string[]): { objs: Obj[]; freed: string[] } {
  const groups = objs.filter((o) => ids.includes(o.id) && o.type === "group");
  if (groups.length === 0) return { objs, freed: [] };
  const gset = new Map(groups.map((g) => [g.id, g.parent ?? null]));
  const freed: string[] = [];
  const out = objs
    .filter((o) => !gset.has(o.id))
    .map((o) => {
      if (o.parent && gset.has(o.parent)) {
        freed.push(o.id);
        return { ...o, parent: gset.get(o.parent) };
      }
      return o;
    });
  return { objs: out, freed };
}

/** Кому из рамок принадлежит центр объекта; берётся самая верхняя по слоям. */
export function frameAt(objs: Obj[], p: Pt, skip: Set<string>): string | null {
  for (let i = objs.length - 1; i >= 0; i--) {
    const f = objs[i];
    if (f.type !== "frame" || skip.has(f.id) || f.hidden) continue;
    if (boxContains(f, p)) return f.id;
  }
  return null;
}

/** После переноса объект переходит в рамку, над которой оказался его центр (или выходит из неё). */
export function reparent(objs: Obj[], ids: Iterable<string>): Obj[] {
  const moved = new Set(ids);
  const skip = withChildren(objs, moved);
  const byId = mapById(objs);
  let changed = false;
  const next = objs.map((o) => {
    if (!moved.has(o.id) || o.type === "line") return o;
    const parent = o.parent ? byId.get(o.parent) : undefined;
    // внутри группы объект остаётся: рамка определяется для самой группы
    if (parent?.type === "group") return o;
    const target = frameAt(objs, center(o), skip);
    if ((o.parent ?? null) === target) return o;
    changed = true;
    return { ...o, parent: target };
  });
  return changed ? next : objs;
}

/** Копии с новыми идентификаторами; связи между скопированными объектами сохраняются. */
export function cloneObjs(
  objs: Obj[],
  ids: Iterable<string>,
  dx: number,
  dy: number,
): { copies: Obj[]; roots: string[] } {
  const all = withChildren(objs, ids);
  const src = objs.filter((o) => all.has(o.id));
  const map = new Map(src.map((o) => [o.id, uid()]));
  const byId = mapById(objs);
  const rebind = (a: Obj["from"]): Obj["from"] => {
    if (!a) return a;
    if (a.id && map.has(a.id)) return { ...a, id: map.get(a.id) };
    // привязка к тому, что не копируется: конец зависает в точке привязки
    if (a.id) return undefined;
    return { ...a, x: (a.x ?? 0) + dx, y: (a.y ?? 0) + dy };
  };
  const copies: Obj[] = [];
  for (const o of src) {
    if (o.type === "line") {
      const ends = lineEnds(o, byId);
      const free = (a: Obj["from"], e: { x: number; y: number }) => {
        const r = rebind(a);
        return r ?? { x: e.x + dx, y: e.y + dy };
      };
      copies.push({
        ...o,
        id: map.get(o.id)!,
        parent: o.parent && map.has(o.parent) ? map.get(o.parent) : null,
        from: free(o.from, ends.a),
        to: free(o.to, ends.b),
      });
    } else {
      copies.push({
        ...o,
        id: map.get(o.id)!,
        x: o.x + dx,
        y: o.y + dy,
        parent: o.parent && map.has(o.parent) ? map.get(o.parent) : null,
      });
    }
  }
  const idSet = new Set(ids);
  const roots = src.filter((o) => idSet.has(o.id)).map((o) => map.get(o.id)!);
  return { copies, roots };
}

/** Удаление с потомками; соединители, потерявшие объект, остаются со свободным концом. */
export function deleteObjs(objs: Obj[], ids: Iterable<string>): Obj[] {
  const gone = withChildren(objs, ids);
  const byId = mapById(objs);
  const out: Obj[] = [];
  for (const o of objs) {
    if (gone.has(o.id)) continue;
    if (o.type === "line") {
      const ends = lineEnds(o, byId);
      const fix = (a: Obj["from"], e: { x: number; y: number }) =>
        a?.id && gone.has(a.id) ? { x: e.x, y: e.y } : a;
      out.push({ ...o, from: fix(o.from, ends.a), to: fix(o.to, ends.b) });
    } else out.push(o);
  }
  return pruneGroups(out);
}

export type Order = "front" | "back" | "forward" | "backward";

export function reorder(objs: Obj[], ids: Iterable<string>, how: Order): Obj[] {
  const set = withChildren(objs, ids);
  const sel = objs.filter((o) => set.has(o.id));
  const rest = objs.filter((o) => !set.has(o.id));
  if (how === "front") return [...rest, ...sel];
  if (how === "back") return [...sel, ...rest];
  const out = [...objs];
  if (how === "forward") {
    for (let i = out.length - 2; i >= 0; i--) {
      if (set.has(out[i].id) && !set.has(out[i + 1].id))
        [out[i], out[i + 1]] = [out[i + 1], out[i]];
    }
  } else {
    for (let i = 1; i < out.length; i++) {
      if (set.has(out[i].id) && !set.has(out[i - 1].id))
        [out[i], out[i - 1]] = [out[i - 1], out[i]];
    }
  }
  return out;
}

/** Габарит выбранных объектов (с поворотом). */
export function selectionBox(objs: Obj[], ids: string[]): Box | null {
  const byId = mapById(objs);
  const list = ids.map((i) => byId.get(i)).filter((o): o is Obj => !!o);
  return unionBox(list.map((o) => boundsOf(o, byId)));
}

/** Поворот набора объектов вокруг общей точки. */
export function rotateAround(objs: Obj[], ids: Set<string>, c: Pt, deg: number): Obj[] {
  return objs.map((o) => {
    if (!ids.has(o.id) || o.type === "line" || o.type === "group") return o;
    const oc = rotatePt(center(o), c, deg);
    return { ...o, x: oc.x - o.w / 2, y: oc.y - o.h / 2, rot: (((o.rot + deg) % 360) + 360) % 360 };
  });
}

/** Прямоугольник, охватывающий точки (для рисунка). */
export const boxOfPoints = (pts: Pt[]): Box => aabbOf(pts);

export const cornersOf = corners;

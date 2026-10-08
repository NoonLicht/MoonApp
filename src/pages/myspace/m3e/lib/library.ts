import { useCallback, useState } from "react";
import { sanitizeSpec, type CustomSpec } from "@/pages/myspace/m3e/lib/custom";
import { makeItem, type Item } from "@/pages/myspace/m3e/lib/tokens";

const KEY = "m3e:library:v1";
const MAX = 60;

/** Элемент холста из описания (готового, из библиотеки или от ИИ). */
export function makeCustomItem(spec: CustomSpec): Item {
  const it = makeItem("custom");
  return { ...it, label: spec.name, size: spec.w, size2: spec.h, node: spec.node };
}

export function loadLibrary(): CustomSpec[] {
  try {
    const raw = JSON.parse(localStorage.getItem(KEY) ?? "[]");
    if (!Array.isArray(raw)) return [];
    return raw.map((r) => sanitizeSpec(r)).filter((x): x is CustomSpec => !!x);
  } catch {
    return [];
  }
}

function persist(list: CustomSpec[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(list));
  } catch {
    /* без запоминания */
  }
}

/** «Мои элементы»: то, что автор сохранил сам или получил от ИИ. Хранится в браузере. */
export function useLibrary() {
  const [list, setList] = useState<CustomSpec[]>(loadLibrary);
  const save = useCallback((spec: CustomSpec) => {
    setList((cur) => {
      const next = [spec, ...cur.filter((x) => JSON.stringify(x) !== JSON.stringify(spec))].slice(
        0,
        MAX,
      );
      persist(next);
      return next;
    });
  }, []);
  const remove = useCallback((i: number) => {
    setList((cur) => {
      const next = cur.filter((_, j) => j !== i);
      persist(next);
      return next;
    });
  }, []);
  return { list, save, remove };
}

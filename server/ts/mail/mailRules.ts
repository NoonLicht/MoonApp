/**
 * Правила обработки входящих писем (как «Mail rules» в Mailspring / «фильтры» в Thunderbird).
 *
 * Условие: поле + оператор + значение. Действия: переместить в папку, прочитать, звезда,
 * удалить (в корзину), в спам, отложить на N часов, переслать-копию не выполняется (нужен SMTP).
 */
export type RuleField = "from" | "to" | "cc" | "subject" | "body" | "hasAttachment" | "list" | "size";
export type RuleOp = "contains" | "notContains" | "equals" | "startsWith" | "endsWith" | "regex" | "gt" | "lt" | "is";

export interface RuleCondition {
  field: RuleField;
  op: RuleOp;
  value: string;
}

export type RuleActionType = "move" | "markRead" | "star" | "trash" | "spam" | "archive" | "snooze" | "label";

export interface RuleAction {
  type: RuleActionType;
  /** move: путь папки; snooze: часы; label: метка. */
  value?: string;
}

export interface Rule {
  id: string;
  account: string;
  name: string;
  enabled: boolean;
  matchAll: boolean;
  conditions: RuleCondition[];
  actions: RuleAction[];
  position: number;
}

export interface RuleSubject {
  from: string;
  fromName: string;
  to: string;
  cc: string;
  subject: string;
  body: string;
  hasAttachment: boolean;
  isList: boolean;
  size: number;
}

function fieldText(m: RuleSubject, f: RuleField): string {
  switch (f) {
    case "from":
      return `${m.fromName} ${m.from}`;
    case "to":
      return m.to;
    case "cc":
      return m.cc;
    case "subject":
      return m.subject;
    case "body":
      return m.body;
    default:
      return "";
  }
}

export function matchCondition(c: RuleCondition, m: RuleSubject): boolean {
  if (c.field === "hasAttachment") return m.hasAttachment === (c.value !== "false");
  if (c.field === "list") return m.isList === (c.value !== "false");
  if (c.field === "size") {
    const n = Number(c.value) * 1024;
    return c.op === "lt" ? m.size < n : m.size > n;
  }
  const hay = fieldText(m, c.field).toLowerCase();
  const val = c.value.toLowerCase();
  switch (c.op) {
    case "contains":
      return hay.includes(val);
    case "notContains":
      return !hay.includes(val);
    case "equals":
    case "is":
      return hay.trim() === val.trim() || (c.field === "from" && m.from.toLowerCase() === val.trim());
    case "startsWith":
      return hay.startsWith(val);
    case "endsWith":
      return hay.endsWith(val);
    case "regex":
      try {
        return new RegExp(c.value, "i").test(fieldText(m, c.field));
      } catch {
        return false;
      }
    default:
      return false;
  }
}

export function matchRule(r: Rule, m: RuleSubject): boolean {
  if (!r.enabled || !r.conditions.length) return false;
  const res = r.conditions.map((c) => matchCondition(c, m));
  return r.matchAll ? res.every(Boolean) : res.some(Boolean);
}

/** Собирает действия всех подошедших правил по порядку; «трогающие папку» — только первое. */
export function actionsFor(rules: Rule[], m: RuleSubject): RuleAction[] {
  const out: RuleAction[] = [];
  let moved = false;
  for (const r of [...rules].sort((a, b) => a.position - b.position)) {
    if (!matchRule(r, m)) continue;
    for (const a of r.actions) {
      const isMove = a.type === "move" || a.type === "trash" || a.type === "spam" || a.type === "archive";
      if (isMove) {
        if (moved) continue;
        moved = true;
      }
      out.push(a);
    }
  }
  return out;
}

/** «Отписаться»: выбирает способ из заголовков List-Unsubscribe. */
export function parseListUnsubscribe(
  header: string,
  oneClick: boolean,
): { https?: string; mailto?: string; oneClick: boolean } {
  const urls = [...header.matchAll(/<([^>]+)>/g)].map((m) => m[1].trim());
  return {
    https: urls.find((u) => /^https?:/i.test(u)),
    mailto: urls.find((u) => /^mailto:/i.test(u)),
    oneClick,
  };
}

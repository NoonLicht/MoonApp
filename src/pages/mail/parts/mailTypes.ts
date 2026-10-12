import type { MailMessage } from "@/api/apiMail";

/** Что показывает список писем. */
export type MailView =
  | { kind: "box"; id: string }
  | { kind: "folder"; account: string; path: string; name: string }
  | { kind: "label"; account: string; label: string }
  | { kind: "smart"; id: string }
  | { kind: "outbox" }
  | { kind: "tracking" };

export function sameView(a: MailView, b: MailView): boolean {
  if (a.kind !== b.kind) return false;
  switch (a.kind) {
    case "box":
      return a.id === (b as typeof a).id;
    case "folder":
      return a.account === (b as typeof a).account && a.path === (b as typeof a).path;
    case "label":
      return a.account === (b as typeof a).account && a.label === (b as typeof a).label;
    case "smart":
      return a.id === (b as typeof a).id;
    default:
      return true;
  }
}

/** Куда переносить при перетаскивании на пункт боковой панели. */
export const BOX_SPECIAL: Record<string, string> = {
  inbox: "\\Inbox",
  archive: "\\Archive",
  spam: "\\Junk",
  trash: "\\Trash",
};

export const DRAG_MIME = "application/x-moonapp-mail";

export type MailRow = MailMessage;

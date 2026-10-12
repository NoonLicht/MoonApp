/**
 * Календарные приглашения (iCalendar): разбор VEVENT и ответ участника (iMIP REPLY).
 */
export interface IcsEvent {
  method: string;
  uid: string;
  summary: string;
  start: number;
  end: number;
  allDay: boolean;
  location: string;
  description: string;
  organizer: string;
  organizerName: string;
  status: string;
  sequence: number;
}

function unfold(s: string): string[] {
  return s.replace(/\r?\n[ \t]/g, "").split(/\r?\n/);
}

function unescapeText(s: string): string {
  return s.replace(/\\n/gi, "\n").replace(/\\,/g, ",").replace(/\\;/g, ";").replace(/\\\\/g, "\\");
}

/** DTSTART:20260105T090000Z | DTSTART;TZID=...:20260105T090000 | DTSTART;VALUE=DATE:20260105 */
function parseDate(line: string): { ts: number; allDay: boolean } {
  const [head, value = ""] = [line.slice(0, line.indexOf(":")), line.slice(line.indexOf(":") + 1)];
  const allDay = /VALUE=DATE(?!-)/i.test(head) || /^\d{8}$/.test(value.trim());
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) return { ts: 0, allDay };
  const [, y, mo, d, h = "0", mi = "0", s = "0", z] = m;
  const ts = z
    ? Date.UTC(+y, +mo - 1, +d, +h, +mi, +s)
    : new Date(+y, +mo - 1, +d, +h, +mi, +s).getTime();
  return { ts, allDay };
}

export function parseIcs(text: string): IcsEvent | null {
  const lines = unfold(text);
  let inEvent = false;
  let method = "";
  const ev: IcsEvent = {
    method: "",
    uid: "",
    summary: "",
    start: 0,
    end: 0,
    allDay: false,
    location: "",
    description: "",
    organizer: "",
    organizerName: "",
    status: "",
    sequence: 0,
  };
  let found = false;
  for (const line of lines) {
    const up = line.toUpperCase();
    if (up.startsWith("METHOD:")) method = line.slice(7).trim().toUpperCase();
    if (up === "BEGIN:VEVENT") {
      inEvent = true;
      found = true;
      continue;
    }
    if (up === "END:VEVENT") break;
    if (!inEvent) continue;
    const key = up.split(/[;:]/)[0];
    const val = line.slice(line.indexOf(":") + 1);
    switch (key) {
      case "UID":
        ev.uid = val.trim();
        break;
      case "SUMMARY":
        ev.summary = unescapeText(val);
        break;
      case "LOCATION":
        ev.location = unescapeText(val);
        break;
      case "DESCRIPTION":
        ev.description = unescapeText(val).slice(0, 2000);
        break;
      case "STATUS":
        ev.status = val.trim().toUpperCase();
        break;
      case "SEQUENCE":
        ev.sequence = Number(val) || 0;
        break;
      case "DTSTART": {
        const d = parseDate(line);
        ev.start = d.ts;
        ev.allDay = d.allDay;
        break;
      }
      case "DTEND":
        ev.end = parseDate(line).ts;
        break;
      case "ORGANIZER": {
        ev.organizer = val.replace(/^mailto:/i, "").trim();
        const cn = /CN="?([^;:"]+)"?/i.exec(line);
        ev.organizerName = cn ? cn[1] : "";
        break;
      }
      default:
    }
  }
  if (!found) return null;
  ev.method = method || "REQUEST";
  if (!ev.end) ev.end = ev.start;
  return ev;
}

const fmtUtc = (ts: number) =>
  new Date(ts)
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d{3}/, "");

/** Ответ участника: PARTSTAT = ACCEPTED | DECLINED | TENTATIVE. */
export function buildReply(
  ev: IcsEvent,
  attendeeEmail: string,
  attendeeName: string,
  partstat: "ACCEPTED" | "DECLINED" | "TENTATIVE",
): string {
  return [
    "BEGIN:VCALENDAR",
    "PRODID:-//MoonApp//Mail//EN",
    "VERSION:2.0",
    "METHOD:REPLY",
    "BEGIN:VEVENT",
    `UID:${ev.uid}`,
    `DTSTAMP:${fmtUtc(Date.now())}`,
    `SEQUENCE:${ev.sequence}`,
    `ORGANIZER:mailto:${ev.organizer}`,
    `ATTENDEE;PARTSTAT=${partstat};CN=${attendeeName.replace(/[;:,"]/g, " ")}:mailto:${attendeeEmail}`,
    `DTSTART:${fmtUtc(ev.start)}`,
    `DTEND:${fmtUtc(ev.end)}`,
    `SUMMARY:${ev.summary.replace(/\r?\n/g, " ")}`,
    "END:VEVENT",
    "END:VCALENDAR",
    "",
  ].join("\r\n");
}

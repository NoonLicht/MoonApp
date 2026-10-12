/**
 * Локальный MCP-сервер почты: ИИ-клиент (Claude Desktop, Cursor и др.) читает ящики приложения.
 *
 * Streamable-HTTP (JSON-RPC 2.0 в теле POST) на 127.0.0.1:<port>/mcp, доступ — только по
 * заголовку Authorization: Bearer <ключ из настроек>. Инструменты только читают; отправка
 * включается отдельным переключателем и всё равно идёт через очередь «Исходящие» с отменой.
 * Для клиентов со stdio-транспортом: npx mcp-remote http://127.0.0.1:<port>/mcp --header "Authorization: Bearer <ключ>".
 */
import crypto from "crypto";
import http from "http";
import { getSettings } from "./mailSettings";
import {
  contactCard,
  getMessage,
  getThread,
  listAccounts,
  listFolders,
  listMessages,
  queueSend,
  boxCounts,
  type MessageFull,
} from "./mailService";
import logger from "../logger";

interface Rpc {
  jsonrpc: "2.0";
  id?: number | string | null;
  method: string;
  params?: Record<string, unknown>;
}

const TOOLS = [
  {
    name: "mail_list_accounts",
    description: "List connected mail accounts with unread counts.",
    inputSchema: { type: "object", properties: {} },
  },
  {
    name: "mail_list_folders",
    description: "List folders of an account.",
    inputSchema: {
      type: "object",
      properties: { account: { type: "string" } },
      required: ["account"],
    },
  },
  {
    name: "mail_search",
    description:
      "Search messages. Query supports from: to: subject: label: has:attachment is:unread is:starred before:/after: YYYY-MM-DD and free text (also searches attachment text).",
    inputSchema: {
      type: "object",
      properties: {
        query: { type: "string" },
        account: { type: "string", description: "account id or omit for all" },
        box: { type: "string", description: "inbox|sent|drafts|trash|spam|archive|starred" },
        unread_only: { type: "boolean" },
        limit: { type: "number" },
      },
    },
  },
  {
    name: "mail_get_message",
    description: "Get one message body (plain text) with headers and attachment names.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, max_chars: { type: "number" } },
      required: ["id"],
    },
  },
  {
    name: "mail_get_thread",
    description: "Get all messages of the conversation that contains the given message id.",
    inputSchema: {
      type: "object",
      properties: { id: { type: "string" }, max_chars_each: { type: "number" } },
      required: ["id"],
    },
  },
  {
    name: "mail_unread_summary",
    description: "Counts of unread messages by box and the newest unread messages.",
    inputSchema: { type: "object", properties: { limit: { type: "number" } } },
  },
  {
    name: "mail_contact",
    description: "How many messages came from an address and recent subjects.",
    inputSchema: {
      type: "object",
      properties: { address: { type: "string" } },
      required: ["address"],
    },
  },
  {
    name: "mail_send",
    description:
      "Queue an email for sending (cancellable for a short time). Disabled unless enabled in the app.",
    inputSchema: {
      type: "object",
      properties: {
        account: { type: "string" },
        to: { type: "array", items: { type: "string" } },
        subject: { type: "string" },
        body: { type: "string" },
      },
      required: ["account", "to", "subject", "body"],
    },
  },
];

function plain(m: MessageFull, max: number): string {
  const t =
    m.text || m.html.replace(/<(script|style)[\s\S]*?<\/\1>/gi, " ").replace(/<[^>]+>/g, " ");
  return t
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim()
    .slice(0, max);
}

function brief(m: ReturnType<typeof listMessages>[number]) {
  return {
    id: m.id,
    account: m.account,
    folder: m.folder,
    from: m.fromName ? `${m.fromName} <${m.fromAddr}>` : m.fromAddr,
    to: m.to.map((a) => a.address),
    subject: m.subject,
    date: new Date(m.date).toISOString(),
    unread: !m.seen,
    starred: m.flagged,
    attachments: m.hasAttachments,
    snippet: m.snippet,
    threadMessages: m.count ?? 1,
  };
}

function callTool(name: string, a: Record<string, unknown>): unknown {
  const str = (k: string) => (typeof a[k] === "string" ? (a[k] as string) : "");
  const num = (k: string, d: number) => (typeof a[k] === "number" ? (a[k] as number) : d);
  switch (name) {
    case "mail_list_accounts":
      return listAccounts().map((x) => ({
        id: x.id,
        email: x.email,
        name: x.name,
        unread: x.unread,
        lastSync: x.lastSync,
      }));
    case "mail_list_folders":
      return listFolders(str("account"));
    case "mail_search":
      return listMessages({
        account: str("account") || undefined,
        box: str("box") || undefined,
        q: str("query") || undefined,
        unread: a.unread_only === true,
        limit: Math.min(num("limit", 20), 100),
      }).map(brief);
    case "mail_get_message": {
      const m = getMessage(str("id"));
      if (!m) throw new Error("message not found");
      return {
        ...brief(m),
        cc: m.cc.map((x) => x.address),
        body: plain(m, Math.min(num("max_chars", 8000), 50_000)),
        attachmentFiles: m.attachments
          .filter((x) => !x.inline)
          .map((x) => ({ name: x.filename, size: x.size, type: x.contentType })),
        unsubscribe: !!m.unsubscribe,
        invite: m.ics
          ? {
              summary: m.ics.summary,
              start: new Date(m.ics.start).toISOString(),
              location: m.ics.location,
            }
          : null,
      };
    }
    case "mail_get_thread": {
      const max = Math.min(num("max_chars_each", 3000), 20_000);
      return getThread(str("id")).map((m) => ({ ...brief(m), body: plain(m, max) }));
    }
    case "mail_unread_summary":
      return {
        counts: boxCounts(),
        newest: listMessages({
          box: "inbox",
          unread: true,
          limit: Math.min(num("limit", 10), 50),
        }).map(brief),
      };
    case "mail_contact":
      return contactCard(str("address"));
    case "mail_send": {
      if (!getSettings().mcp.allowSend)
        throw new Error("sending is disabled in MoonApp mail settings");
      const to = Array.isArray(a.to) ? (a.to as unknown[]).map(String) : [];
      const body = str("body");
      return queueSend({
        account: str("account"),
        to,
        subject: str("subject"),
        html: body.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/\n/g, "<br>"),
        text: body,
        delayMs: 30_000,
      });
    }
    default:
      throw new Error(`unknown tool ${name}`);
  }
}

function handle(rpc: Rpc): unknown {
  const ok = (result: unknown) => ({ jsonrpc: "2.0", id: rpc.id ?? null, result });
  const err = (code: number, message: string) => ({
    jsonrpc: "2.0",
    id: rpc.id ?? null,
    error: { code, message },
  });
  switch (rpc.method) {
    case "initialize":
      return ok({
        protocolVersion: "2025-03-26",
        capabilities: { tools: {} },
        serverInfo: { name: "moonapp-mail", version: "1.0.0" },
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({
        tools: getSettings().mcp.allowSend ? TOOLS : TOOLS.filter((t) => t.name !== "mail_send"),
      });
    case "tools/call": {
      const p = rpc.params ?? {};
      try {
        const data = callTool(String(p.name), (p.arguments as Record<string, unknown>) ?? {});
        return ok({ content: [{ type: "text", text: JSON.stringify(data, null, 2) }] });
      } catch (e) {
        return ok({ content: [{ type: "text", text: (e as Error).message }], isError: true });
      }
    }
    default:
      return err(-32601, `Method not found: ${rpc.method}`);
  }
}

let server: http.Server | null = null;
let runningPort = 0;

export function mcpStatus(): { running: boolean; port: number } {
  return { running: !!server, port: runningPort };
}

export function stopMcp(): void {
  if (server) {
    server.close();
    server = null;
    runningPort = 0;
  }
}

/** Приводит состояние сервера в соответствие с настройками. */
export function syncMcp(): void {
  const s = getSettings().mcp;
  if (!s.enabled || !s.key) {
    stopMcp();
    return;
  }
  if (server && runningPort === s.port) return;
  stopMcp();
  const srv = http.createServer((req, res) => {
    const send = (code: number, body: unknown) => {
      res.writeHead(code, { "Content-Type": "application/json" });
      res.end(JSON.stringify(body));
    };
    const key = getSettings().mcp.key;
    if (req.url?.split("?")[0] !== "/mcp") return send(404, { error: "not_found" });
    const got = Buffer.from(String(req.headers.authorization || ""));
    const want = Buffer.from(`Bearer ${key}`);
    if (!key || got.length !== want.length || !crypto.timingSafeEqual(got, want)) {
      return send(401, { error: "unauthorized" });
    }
    if (req.method !== "POST") return send(405, { error: "use POST" });
    let raw = "";
    req.on("data", (c: Buffer) => {
      raw += c.toString("utf8");
      if (raw.length > 1_000_000) req.destroy();
    });
    req.on("end", () => {
      try {
        const body = JSON.parse(raw) as Rpc | Rpc[];
        if (Array.isArray(body))
          return send(200, body.filter((r) => r.id !== undefined).map(handle));
        if (body.id === undefined) {
          res.writeHead(202);
          return res.end();
        }
        send(200, handle(body));
      } catch {
        send(400, { jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
      }
    });
  });
  srv.on("error", (e) => {
    logger.warn("mail.mcp_error", { error: (e as Error).message });
    server = null;
    runningPort = 0;
  });
  srv.listen(s.port, "127.0.0.1", () => {
    server = srv;
    runningPort = s.port;
  });
}

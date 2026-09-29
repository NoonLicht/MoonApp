/**
 * DPI Bypass — Linux-реализация. Читает ТЕ ЖЕ конфиги стратегий (general*.bat
 * из движка Flowseal/zapret-discord-youtube, который Windows-версия качает и
 * парсит в server/zapret.js), но вместо winws.exe/WinDivert запускает
 * `nfqws` (userspace-часть проекта bol-van/zapret — из его исходников,
 * собран pyёт winws.exe) через NFQUEUE.
 *
 * Почему конфиги можно переиспользовать бит-в-бит: winws.exe и nfqws —
 * порты ОДНОГО и того же движка (bol-van/zapret) под разные платформы, и все
 * содержательные флаги (--dpi-desync*, --hostlist*, --ipset*, --filter-tcp/
 * udp/l7, --new) у них идентичны. Отличаются только флаги ВЫБОРА пакетов:
 * winws сам перехватывает трафик через WinDivert-фильтр (--wf-tcp=/--wf-udp=
 * с портами прямо в аргументах), а nfqws лишь ОБРАБАТЫВАЕТ то, что ему отдаёт
 * ядро через NFQUEUE — выбор трафика делает отдельное правило
 * iptables/nftables. Поэтому вся эта реализация — не переписывание стратегий
 * с нуля, а перевод --wf-tcp/--wf-udp в правило NFQUEUE и передача остального
 * набора флагов без изменений через parseBatConfig() из zapret.js (та функция
 * уже полностью платформенно-нейтральна — просто текстовый парсинг .bat).
 *
 * ЧТО НЕ ПОРТИРОВАНО (осознанно, вне этого прохода — см. финальный отчёт):
 * список профилей/доменов в БД, диагностика/auto-tune, установка как службы,
 * редактирование пользовательских списков из UI. Все эти route обработчики
 * на Linux отвечают {error: "not_implemented_on_linux"} вместо того, чтобы
 * падать — см. server/routes/zapret.js. GitHub-автообновление КОНФИГОВ
 * (general*.bat/lists/bin/*.bin из Flowseal/zapret-discord-youtube) —
 * реализовано ниже (checkUpdate/installEngine/installStatus): скачивает тот
 * же релиз, что и Windows-версия, но копирует из него только содержательные
 * данные (сами настройки обхода), а Windows-бинарники (winws.exe,
 * WinDivert*.dll/.sys, cygwin1.dll) — пропускает. Бинарник nfqws в этот
 * процесс НЕ входит и не перезаписывается: это отдельный апстрим
 * (bol-van/zapret), пользователь ставит/обновляет его вручную.
 */
import { spawn, execFile, type ChildProcess } from "child_process";
import fs from "fs";
import path from "path";
import config from "./config";
import logger from "./logger";
import { downloadToFile } from "./download";

// Чисто текстовый парсинг .bat/поиск .bin — ничего платформенно-специфичного,
// поэтому require("./zapret") безопасен и на Linux (см. обоснование в шапке).
// Отсюда же переиспользуем GITHUB_REPO/USER_LISTS/ensureUserLists/
// writeGameFilter/gameFilterFile — это тоже чистая работа с файлами/текстом
// (ensureUserLists пробует execFileSync("cmd.exe", ...) только внутри
// try/catch, на Linux ENOENT молча ловится и код падает на дефолты).
// eslint-disable-next-line @typescript-eslint/no-require-imports
const zapretWin = require("./zapret") as {
  parseBatConfig(batPath: string): { tokens: string[] };
  strategyId(fileName: string): string;
  strategyGroup(fileName: string): string;
  GITHUB_REPO: string;
  USER_LISTS: string[];
  ensureUserLists(dir?: string): unknown;
  writeGameFilter(): string;
  gameFilterFile(dir?: string): string;
};

const { DIRS } = config;

interface Strategy {
  id: string;
  name: string;
  label: string;
  group: string;
  file: string;
  filePath: string;
  tokens: string[];
}

interface EngineStatus {
  found: boolean;
  dir: string | null;
  binDir: string | null;
  listsDir: string | null;
  nfqws: string | null;
  nfqwsFound: boolean;
}

/** Каталоги-кандидаты движка: тот же порядок приоритета, что у Windows-версии. */
function engineDirCandidates(): string[] {
  return [
    process.env.MOONAPP_ZAPRET,
    DIRS.zapret,
    path.join(__dirname, "..", "storage_linux", "zapret"),
  ].filter((p): p is string => !!p);
}

/** Каталог движка «найден», если в нём лежат lists/ и хотя бы один general*.bat. */
function findEngineDir(): string | null {
  for (const dir of engineDirCandidates()) {
    try {
      if (!fs.existsSync(path.join(dir, "lists"))) continue;
      const hasGeneral = fs.readdirSync(dir).some((f) => /^general.*\.bat$/i.test(f));
      if (hasGeneral) return dir;
    } catch {
      /* каталога нет — пробуем следующий кандидат */
    }
  }
  return null;
}

/** Имя архитектурной подпапки в официальном архиве релиза bol-van/zapret
 * (storage_linux/zapret/nfqws/binaries/<arch>/nfqws) — совпадает с именами
 * подпапок релиза v72.13, не с Node-именами process.arch. */
function nfqwsArchDir(): string {
  switch (process.arch) {
    case "x64":
      return "linux-x86_64";
    case "arm64":
      return "linux-arm64";
    case "arm":
      return "linux-arm";
    case "ia32":
      return "linux-x86";
    default:
      return "linux-x86_64";
  }
}

/**
 * nfqws не входит в репозиторий и не скачивается автоматически (нужен
 * компилятор/пакет дистрибутива) — пользователь кладёт его вручную. Официальный
 * релиз bol-van/zapret распаковывается ЦЕЛИКОМ (папка `nfqws/` внутри архива,
 * содержащая `binaries/<arch>/nfqws` вместе с install-скриптами/доками) — то
 * есть `storage_linux/zapret/nfqws` САМ является каталогом, а не файлом, и
 * generic-резолвер config.vendorBin() тут не годится: fs.existsSync() у него
 * вернёт true и для каталога, spawn() же на каталоге упадёт с EACCES/ENOENT
 * по факту запуска. Ищем конкретный исполняемый файл внутри этого дерева.
 */
/** Ищет `nfqws` прямо в PATH (например на NixOS, где его удобнее поставить
 * отдельным Nix-пакетом/деривацией, чем распаковывать релиз вручную). */
function nfqwsInSystemPath(): string | null {
  const dirs = (process.env.PATH || "").split(path.delimiter).filter(Boolean);
  for (const dir of dirs) {
    const candidate = path.join(dir, "nfqws");
    try {
      if (fs.statSync(candidate).isFile()) return candidate;
    } catch {
      /* нет в этой директории PATH — пробуем следующую */
    }
  }
  return null;
}

function nfqwsPath(): string {
  const st = findEngineDir();
  const candidates = [
    // Системный PATH — приоритетнее ручной раскладки: если nfqws уже
    // поставлен пакетным менеджером (Nix-деривация, apt и т.п.), он обычно
    // и настроен/пропатчен под систему лучше, чем то, что положили вручную.
    nfqwsInSystemPath(),
    // Официальная раскладка релиза bol-van/zapret v72.x (архив распакован
    // прямо в storage_linux/zapret/, поэтому nfqws/ — подпапка zapret/).
    st ? path.join(st, "nfqws", "binaries", nfqwsArchDir(), "nfqws") : null,
    path.join(DIRS.zapret, "nfqws", "binaries", nfqwsArchDir(), "nfqws"),
    path.join(__dirname, "..", "storage_linux", "zapret", "nfqws", "binaries", nfqwsArchDir(), "nfqws"),
    // На случай, если пользователь положит уже собранный бинарь напрямую
    // (пакет дистрибутива вида `zapret-nfqws`, без всего дерева релиза).
    config.vendorBin("zapret", "nfqws"),
  ].filter((p): p is string => !!p);
  for (const c of candidates) {
    try {
      if (fs.statSync(c).isFile()) return c;
    } catch {
      /* пробуем следующего кандидата */
    }
  }
  return candidates[candidates.length - 1];
}

export function engineStatus(): EngineStatus {
  const dir = findEngineDir();
  const nfqws = nfqwsPath();
  return {
    found: !!dir,
    dir,
    binDir: dir ? path.join(dir, "bin") : null,
    listsDir: dir ? path.join(dir, "lists") : null,
    nfqws,
    nfqwsFound: fs.existsSync(nfqws),
  };
}

export function listStrategies(): Strategy[] {
  const st = engineStatus();
  if (!st.dir) return [];
  const out: Strategy[] = [];
  try {
    for (const f of fs.readdirSync(st.dir)) {
      if (!/^general.*\.bat$/i.test(f)) continue;
      const filePath = path.join(st.dir, f);
      out.push({
        id: zapretWin.strategyId(f),
        name: f.replace(/\.bat$/i, ""),
        label: (f.match(/\(([^)]*)\)/) || [])[1] || "default",
        group: zapretWin.strategyGroup(f),
        file: f,
        filePath,
        tokens: zapretWin.parseBatConfig(filePath).tokens,
      });
    }
  } catch {
    /* нет доступа к каталогу */
  }
  return out;
}

export function listPayloads(): Array<{ name: string; path: string; sizeKb: number }> {
  const st = engineStatus();
  if (!st.binDir) return [];
  try {
    return fs
      .readdirSync(st.binDir)
      .filter((f) => /\.bin$/i.test(f))
      .map((f) => ({
        name: f,
        path: path.join(st.binDir!, f),
        sizeKb: Math.round(fs.statSync(path.join(st.binDir!, f)).size / 102.4) / 10,
      }));
  } catch {
    return [];
  }
}

/**
 * Флаги nfqws, реально существующие в бинарнике (извлечено из docs/*.txt,
 * docs/*.md поставки bol-van/zapret v72.13 — storage_linux/zapret/nfqws/docs).
 * Семейство --wf-* (WinDivert-only выбор трафика — фильтр самого перехватчика
 * пакетов) сюда осознанно не входит: оно обрабатывается отдельно ниже
 * (--wf-tcp=/--wf-udp= превращаются в правило NFQUEUE, остальные --wf-*
 * попадают в «неизвестные», т.к. у nfqws нет для них аналога в принципе —
 * выбор трафика на Linux всегда делает iptables/nftables, а не сам nfqws).
 */
const KNOWN_NFQWS_FLAGS = new Set([
  "--allow-unsupported-windows", "--autottl", "--bind", "--bind-addr", "--bind-fix4", "--bind-fix6",
  "--bind-iface", "--bind-iface4", "--bind-iface6", "--bind-linklocal", "--bind-wait", "--bind-wait-ifup",
  "--bind-wait-ip", "--bind-wait-ip-linklocal", "--bind-wait-only", "--clamp-mss-to-pmtu", "--comment",
  "--config", "--connbytes", "--connbytes-dir", "--connbytes-mode", "--connect-bind-addr", "--ctmask",
  "--ctrack-disable", "--ctrack-timeouts", "--ctstate", "--daemon", "--data-binary", "--debug",
  "--debug-level", "--depth", "--disorder", "--dns-make-query", "--dns-parse-query", "--domcase",
  "--dpi-desync", "--dpi-desync-any-protocol", "--dpi-desync-autottl", "--dpi-desync-autottl6",
  "--dpi-desync-badack-increment", "--dpi-desync-badseq-increment", "--dpi-desync-cutoff",
  "--dpi-desync-fake-dht", "--dpi-desync-fake-discord", "--dpi-desync-fake-http", "--dpi-desync-fake-quic",
  "--dpi-desync-fake-stun", "--dpi-desync-fake-syndata", "--dpi-desync-fake-tcp-mod",
  "--dpi-desync-fake-tls", "--dpi-desync-fake-tls-mod", "--dpi-desync-fake-unknown",
  "--dpi-desync-fake-unknown-udp", "--dpi-desync-fake-wireguard", "--dpi-desync-fake-xxx",
  "--dpi-desync-fakedsplit-mod", "--dpi-desync-fakedsplit-pattern", "--dpi-desync-fooling",
  "--dpi-desync-fwmark", "--dpi-desync-hostfakesplit-midhost", "--dpi-desync-hostfakesplit-mod",
  "--dpi-desync-ipfrag-pos-tcp", "--dpi-desync-ipfrag-pos-udp", "--dpi-desync-repeats",
  "--dpi-desync-retrans", "--dpi-desync-skip-nosni", "--dpi-desync-split-http-req",
  "--dpi-desync-split-pos", "--dpi-desync-split-seqovl", "--dpi-desync-split-seqovl-pattern",
  "--dpi-desync-split-tls", "--dpi-desync-start", "--dpi-desync-tcp-flags", "--dpi-desync-tcp-flags-set",
  "--dpi-desync-tcp-flags-unset", "--dpi-desync-ts-increment", "--dpi-desync-ttl", "--dpi-desync-ttl6",
  "--dpi-desync-udplen-increment", "--dpi-desync-udplen-pattern", "--dport", "--dports", "--dry-run",
  "--dscp", "--dup", "--dup-autottl", "--dup-autottl6", "--dup-badack-increment", "--dup-badseq-increment",
  "--dup-cutoff", "--dup-fooling", "--dup-ip-id", "--dup-replace", "--dup-start", "--dup-tcp-flags",
  "--dup-tcp-flags-set", "--dup-tcp-flags-unset", "--dup-ts-increment", "--dup-ttl", "--dup-ttl6",
  "--eagain", "--eagain-delay", "--enable-pf", "--exec", "--family", "--filter-l3", "--filter-l7",
  "--filter-ssid", "--filter-tcp", "--filter-udp", "--fix-seg", "--force-overwrite", "--gid", "--hostcase",
  "--hostdot", "--hostlist", "--hostlist-auto", "--hostlist-auto-debug", "--hostlist-auto-fail-threshold",
  "--hostlist-auto-fail-time", "--hostlist-auto-retrans-threshold", "--hostlist-domains",
  "--hostlist-exclude", "--hostlist-exclude-domains", "--hostnospace", "--hostpad", "--hostspell",
  "--hosttab", "--import", "--ip-id", "--ipcache-hostname", "--ipcache-lifetime", "--ipset",
  "--ipset-exclude", "--ipset-exclude-ip", "--ipset-ip", "--local-rcvbuf", "--local-sndbuf",
  "--local-tcp-user-timeout", "--log-failed", "--log-resolved", "--mark", "--match-set",
  "--max-orphan-time", "--maxconn", "--maxfiles", "--methodeol", "--methodspace", "--mss", "--new",
  "--nfmask", "--nlm-filter", "--nlm-list", "--no-resolve", "--no-verify", "--nosplice", "--on-port",
  "--oob", "--oob-data", "--orig", "--orig-autottl", "--orig-autottl6", "--orig-mod-cutoff",
  "--orig-mod-start", "--orig-tcp-flags", "--orig-tcp-flags-set", "--orig-tcp-flags-unset", "--orig-ttl",
  "--orig-ttl6", "--pidfile", "--port", "--prefix-length", "--qnum", "--queue-bypass", "--queue-num",
  "--remote-rcvbuf", "--remote-sndbuf", "--remote-tcp-user-timeout", "--resolve-threads",
  "--resolver-threads", "--restore-mark", "--set", "--set-dscp", "--set-mark", "--site", "--skip",
  "--skip-nodelay", "--socks", "--socks5", "--socks5-hostname", "--split-any-protocol",
  "--split-http-req", "--split-pos", "--split-tls", "--sport", "--sports", "--ssid-filter", "--stats",
  "--strip-debug", "--synack-split", "--tamper-cutoff", "--tamper-start", "--tcp-flags", "--threads",
  "--tlsrec", "--tlsrec-pos", "--to", "--to-destination", "--to-port", "--tproxy-mark", "--uid",
  "--uid-owner", "--unixeol", "--unregister", "--user", "--v4-threshold", "--v6-threshold", "--verbose",
  "--version", "--wsize", "--wssize", "--wssize-cutoff", "--wssize-forced-cutoff",
]);

/** Имя флага без значения: "--dpi-desync=fake,split2" → "--dpi-desync". */
function flagName(token: string): string {
  const eq = token.indexOf("=");
  return eq === -1 ? token : token.slice(0, eq);
}

/**
 * Разбирает токены стратегии (уже с подставленными %BIN%/%LISTS%/портами
 * GameFilter — см. parseBatConfig) на «порты для NFQUEUE-правила» и «флаги,
 * которые передаются nfqws без изменений». --wf-tcp=/--wf-udp= — это
 * WinDivert-only флаги выбора трафика, у nfqws таких нет (выбор делает
 * iptables/nftables), поэтому они вырезаются, а их порты идут в правило.
 *
 * Флаги, которых нет ни в списке --wf-tcp/--wf-udp, ни в KNOWN_NFQWS_FLAGS
 * (например новый флаг WinDivert-обвязки, появившийся в свежем конфиге
 * Flowseal раньше, чем в нашей таблице), НЕ прерывают разбор всей стратегии —
 * они пропускаются с явной записью в лог, а остальные, распознанные флаги
 * того же профиля всё равно применяются. Это даёт частичную, но рабочую
 * стратегию вместо полного отказа из-за одного нового аргумента.
 */
function translateTokens(tokens: string[]): {
  tcpPorts: string;
  udpPorts: string;
  nfqwsArgs: string[];
  unknownFlags: string[];
} {
  let tcpPorts = "";
  let udpPorts = "";
  const nfqwsArgs: string[] = [];
  const unknownFlags: string[] = [];
  // Позиционные значения (не начинаются с "--") относятся к предыдущему
  // флагу (например путь после --hostlist) — их пропускаем как есть, они не
  // самостоятельные флаги и не должны попадать в проверку известности.
  let prevWasFlag = false;
  for (const t of tokens) {
    const wfTcp = /^--wf-tcp=(.*)$/.exec(t);
    const wfUdp = /^--wf-udp=(.*)$/.exec(t);
    if (wfTcp) {
      tcpPorts = wfTcp[1];
      prevWasFlag = false;
      continue;
    }
    if (wfUdp) {
      udpPorts = wfUdp[1];
      prevWasFlag = false;
      continue;
    }
    if (!t.startsWith("--")) {
      // Значение предыдущего флага (или самостоятельный неопознанный токен) —
      // включаем его, только если предыдущий известный флаг не был отброшен.
      if (prevWasFlag) nfqwsArgs.push(t);
      continue;
    }
    const name = flagName(t);
    if (name.startsWith("--wf-")) {
      // Прочие WinDivert-only флаги (--wf-raw, --wf-save, --wf-iface и т.п.) —
      // у nfqws нет для них аналога в принципе (это параметры перехватчика
      // пакетов, а не движка обфускации), не только "пока не замаплено".
      unknownFlags.push(t);
      prevWasFlag = false;
      continue;
    }
    if (!KNOWN_NFQWS_FLAGS.has(name)) {
      unknownFlags.push(t);
      prevWasFlag = false;
      continue;
    }
    nfqwsArgs.push(t);
    prevWasFlag = true;
  }
  return { tcpPorts, udpPorts, nfqwsArgs, unknownFlags };
}

const NFT_TABLE = "moonapp_zapret";
const IPT_CHAIN = "MOONAPP_ZAPRET";
const QNUM = 200;

function execFileAsync(cmd: string, args: string[]): Promise<{ ok: boolean; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(cmd, args, { timeout: 8000 }, (err, stdout, stderr) => {
      resolve({ ok: !err, stdout: String(stdout || ""), stderr: String(stderr || err?.message || "") });
    });
  });
}

async function hasNft(): Promise<boolean> {
  return (await execFileAsync("nft", ["--version"])).ok;
}

/** См. killSwitchLinux.ts — тот же приём элевации через pkexec (Polkit). */
async function runPrivileged(cmd: string, args: string[]): Promise<{ ok: boolean; error?: string }> {
  const r = await execFileAsync("pkexec", [cmd, ...args]);
  if (!r.ok) return { ok: false, error: r.stderr || "elevation_failed" };
  return { ok: true };
}

/** Заводит правило NFQUEUE на нужные TCP/UDP-порты (OUTPUT — исходящий трафик). */
async function installQueueRule(tcpPorts: string, udpPorts: string): Promise<{ ok: boolean; error?: string }> {
  if (await hasNft()) {
    const rules = [`add table inet ${NFT_TABLE}`, `add chain inet ${NFT_TABLE} output { type filter hook output priority 0 ; policy accept ; }`];
    if (tcpPorts) rules.push(`add rule inet ${NFT_TABLE} output tcp dport { ${tcpPorts} } queue num ${QNUM} bypass`);
    if (udpPorts) rules.push(`add rule inet ${NFT_TABLE} output udp dport { ${udpPorts} } queue num ${QNUM} bypass`);
    const { writeFileSync, unlinkSync } = await import("fs");
    const os = await import("os");
    const tmp = path.join(os.tmpdir(), `moonapp-zapret-${Date.now()}.nft`);
    writeFileSync(tmp, rules.join("\n"), "utf8");
    try {
      return await runPrivileged("nft", ["-f", tmp]);
    } finally {
      try {
        unlinkSync(tmp);
      } catch {
        /* временный файл, не критично */
      }
    }
  }
  // iptables-фолбэк: multiport поддерживает списки/диапазоны через запятую.
  await runPrivileged("iptables", ["-N", IPT_CHAIN]);
  await runPrivileged("iptables", ["-I", "OUTPUT", "-j", IPT_CHAIN]);
  if (tcpPorts) {
    const r = await runPrivileged("iptables", [
      "-A", IPT_CHAIN, "-p", "tcp", "-m", "multiport", "--dports", tcpPorts, "-j", "NFQUEUE", "--queue-num", String(QNUM), "--queue-bypass",
    ]);
    if (!r.ok) return r;
  }
  if (udpPorts) {
    const r = await runPrivileged("iptables", [
      "-A", IPT_CHAIN, "-p", "udp", "-m", "multiport", "--dports", udpPorts, "-j", "NFQUEUE", "--queue-num", String(QNUM), "--queue-bypass",
    ]);
    if (!r.ok) return r;
  }
  return { ok: true };
}

async function removeQueueRule(): Promise<void> {
  if (await hasNft()) {
    await runPrivileged("nft", ["delete", "table", "inet", NFT_TABLE]);
    return;
  }
  await runPrivileged("iptables", ["-D", "OUTPUT", "-j", IPT_CHAIN]);
  await runPrivileged("iptables", ["-F", IPT_CHAIN]);
  await runPrivileged("iptables", ["-X", IPT_CHAIN]);
}

let activeProcess: ChildProcess | null = null;
let activeStrategyId: string | null = null;
let lastError = "";
const lastLog: string[] = [];

function logLine(line: string): void {
  lastLog.push(`${new Date().toISOString().slice(11, 19)} ${line}`);
  if (lastLog.length > 200) lastLog.splice(0, lastLog.length - 200);
}

export async function start(opts: { strategyId?: string; customArgs?: string } = {}): Promise<{
  ok: boolean;
  strategyId: string;
  pid: number | null;
}> {
  const st = engineStatus();
  if (!st.found) throw new Error("engine_not_found");
  if (!st.nfqwsFound) {
    throw new Error(
      "nfqws_not_found: положите бинарь nfqws в storage_linux/zapret/nfqws (сборка из исходников " +
        "bol-van/zapret либо системный пакет дистрибутива — автозагрузки для него нет)",
    );
  }
  const strat = listStrategies().find((s) => s.id === (opts.strategyId || "general"));
  if (!strat) throw new Error("unknown_strategy");
  const { tcpPorts, udpPorts, nfqwsArgs, unknownFlags } = translateTokens(strat.tokens);
  if (!tcpPorts && !udpPorts) throw new Error("strategy_has_no_ports");
  for (const flag of unknownFlags) {
    logLine(
      `⚠ флаг "${flag}" из конфига "${strat.file}" не поддерживается в Linux-версии (нет аналога у nfqws) — ` +
        `пропущен, остальная часть стратегии применена частично`,
    );
  }

  await stop().catch(() => undefined);
  const rule = await installQueueRule(tcpPorts, udpPorts);
  if (!rule.ok) throw new Error(rule.error || "nftables_rule_failed");

  try {
    fs.chmodSync(st.nfqws!, 0o755);
  } catch {
    /* уже исполняемый, либо нет прав менять — пробуем запустить как есть */
  }
  const args = [...nfqwsArgs, `--qnum=${QNUM}`];
  logLine(
    `start (pkexec): ${strat.id} · ${args.length} args` +
      (unknownFlags.length ? ` · ${unknownFlags.length} флаг(ов) пропущено` : ""),
  );
  const child = spawn("pkexec", [st.nfqws!, ...args], { stdio: ["ignore", "pipe", "pipe"] });
  activeProcess = child;
  activeStrategyId = strat.id;
  child.stdout?.on("data", (d) => logLine(String(d)));
  child.stderr?.on("data", (d) => logLine(String(d)));
  child.on("exit", (code) => {
    logLine(`nfqws exited: code=${code}`);
    if (activeProcess === child) activeProcess = null;
  });
  return { ok: true, strategyId: strat.id, pid: child.pid || null };
}

export async function stop(): Promise<{ ok: boolean }> {
  if (activeProcess) {
    try {
      // pkexec пробрасывает сигнал дочернему процессу; на всякий случай ещё и
      // pkill по бинарю — pkexec иногда переживает SIGTERM самого себя.
      activeProcess.kill("SIGTERM");
    } catch {
      /* процесс уже мог завершиться сам */
    }
    activeProcess = null;
  }
  const st = engineStatus();
  if (st.nfqws) await execFileAsync("pkexec", ["pkill", "-f", st.nfqws]).catch(() => undefined);
  await removeQueueRule();
  activeStrategyId = null;
  return { ok: true };
}

export async function status(): Promise<{
  running: boolean;
  strategyId: string | null;
  pid: number | null;
  log: string[];
  error: string;
  engine: EngineStatus;
}> {
  return {
    running: !!activeProcess,
    strategyId: activeStrategyId,
    pid: activeProcess?.pid || null,
    log: lastLog.slice(-40),
    error: lastError,
    engine: engineStatus(),
  };
}

/** Снимает правило NFQUEUE, оставшееся от аварийно завершённого прошлого
 * запуска — тот же принцип, что startupCleanup() в killSwitch. */
export async function startupCleanup(): Promise<void> {
  try {
    await removeQueueRule();
  } catch (e) {
    logger.error("zapretLinux.startup_cleanup_failed", { error: (e as Error).message });
  }
}

/* ------------------------- GitHub-автообновление КОНФИГОВ ------------------------- */

const GITHUB_REPO = zapretWin.GITHUB_REPO; // "Flowseal/zapret-discord-youtube"
const GITHUB_API = `https://api.github.com/repos/${GITHUB_REPO}`;
const GH_HEADERS = { "User-Agent": "MoonApp", Accept: "application/vnd.github+json" };
const VERSION_FILE = ".pa-bypass.json";

interface ReleaseInfo {
  tag: string;
  name: string;
  publishedAt: string;
  notes: string;
  zipName: string;
  zipUrl: string;
  sizeBytes: number;
  htmlUrl: string;
  at: number;
}

let releaseCache: ReleaseInfo | null = null;
let installState: {
  state: "idle" | "working" | "done" | "error";
  progress: number;
  phase: string;
  error: string;
  tag: string | null;
  at: number;
} = { state: "idle", progress: 0, phase: "", error: "", tag: null, at: 0 };

/** Каталог, КУДА обновляем — тот же, что уже используется (там, где лежит
 * nfqws, чтобы конфиги и бинарник оставались в одном дереве); если движок ещё
 * не разворачивался вовсе — первый кандидат из engineDirCandidates(). */
function updateTargetDir(): string {
  return findEngineDir() || engineDirCandidates()[0] || DIRS.zapret;
}

function localVersion(): { tag: string | null; installedAt: string | null } {
  const dir = findEngineDir();
  if (!dir) return { tag: null, installedAt: null };
  try {
    const j = JSON.parse(fs.readFileSync(path.join(dir, VERSION_FILE), "utf8"));
    if (j && j.tag) return { tag: String(j.tag), installedAt: j.installedAt || null };
  } catch {
    /* нет файла версии — считаем неизвестной */
  }
  return { tag: null, installedAt: null };
}

async function fetchLatestRelease(force = false): Promise<ReleaseInfo> {
  if (!force && releaseCache && Date.now() - releaseCache.at < 10 * 60 * 1000) return releaseCache;
  const res = await fetch(`${GITHUB_API}/releases/latest`, {
    headers: GH_HEADERS,
    redirect: "follow",
    signal: AbortSignal.timeout(25000),
  });
  if (!res.ok) throw new Error(`github_http_${res.status}`);
  const data = await res.json();
  const zip = (data.assets || []).find((a: { name?: string }) => /\.zip$/i.test(a.name || ""));
  if (!zip) throw new Error("no_zip_asset");
  releaseCache = {
    tag: data.tag_name,
    name: data.name || data.tag_name,
    publishedAt: data.published_at,
    notes: String(data.body || "").slice(0, 2000),
    zipName: zip.name,
    zipUrl: zip.browser_download_url,
    sizeBytes: zip.size || 0,
    htmlUrl: data.html_url,
    at: Date.now(),
  };
  return releaseCache;
}

export async function checkUpdate(): Promise<{
  engine: EngineStatus;
  installed: string | null;
  installedAt: string | null;
  latest: string | null;
  hasUpdate: boolean;
  downloadUrl: string | null;
  assetName: string | null;
  sizeBytes: number;
  publishedAt: string | null;
  htmlUrl: string;
  notes: string;
  error: string;
  repo: string;
}> {
  const local = localVersion();
  const out = {
    engine: engineStatus(),
    installed: local.tag,
    installedAt: local.installedAt,
    latest: null as string | null,
    hasUpdate: false,
    downloadUrl: null as string | null,
    assetName: null as string | null,
    sizeBytes: 0,
    publishedAt: null as string | null,
    htmlUrl: `https://github.com/${GITHUB_REPO}/releases`,
    notes: "",
    error: "",
    repo: GITHUB_REPO,
  };
  try {
    const rel = await fetchLatestRelease();
    out.latest = rel.tag;
    out.downloadUrl = rel.zipUrl;
    out.assetName = rel.zipName;
    out.sizeBytes = rel.sizeBytes;
    out.publishedAt = rel.publishedAt;
    out.notes = rel.notes;
    out.htmlUrl = rel.htmlUrl;
    out.hasUpdate = !local.tag || local.tag !== rel.tag;
  } catch (e) {
    out.error = String((e as Error).message || e);
  }
  return out;
}

export function installStatus(): typeof installState & { engine: EngineStatus; installed: string | null } {
  return { ...installState, engine: engineStatus(), installed: localVersion().tag };
}

/** Файлы/папки релиза, которые реально нужны на Linux (настройки движка),
 * без Windows-исполняемых частей (winws.exe, WinDivert-библиотеки, cygwin1.dll
 * — они не запускаются на Linux в принципе, копировать их бессмысленно и
 * вредно, т.к. затирали бы место, где ожидается nfqws). */
function isWantedTopLevel(name: string): boolean {
  return /^general.*\.bat$/i.test(name) || name.toLowerCase() === "lists" || name.toLowerCase() === "utils";
}

/** В bin/ из релиза берём только *.bin (fake-payload'ы) — .dll/.exe/.sys/.tgz отбрасываем. */
function copyBinDirFiltered(srcBin: string, dstBin: string): void {
  if (!fs.existsSync(srcBin)) return;
  fs.mkdirSync(dstBin, { recursive: true });
  for (const f of fs.readdirSync(srcBin)) {
    if (!/\.bin$/i.test(f)) continue; // .dll/.exe/.sys Windows-only — пропуск
    try {
      fs.copyFileSync(path.join(srcBin, f), path.join(dstBin, f));
    } catch {
      /* занятый файл — пропускаем, не критично для остальной установки */
    }
  }
}

function copyDirRecursive(src: string, dst: string): void {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const from = path.join(src, e.name);
    const to = path.join(dst, e.name);
    if (e.isDirectory()) copyDirRecursive(from, to);
    else {
      try {
        fs.copyFileSync(from, to);
      } catch {
        /* занятый файл — пропускаем */
      }
    }
  }
}

/** Находит внутри распакованного архива каталог с реальной полезной нагрузкой
 * (релиз лежит во вложенной папке zapret-discord-youtube-<ver>/). */
function probePayloadDir(root: string): string | null {
  const hasPayload = (p: string): boolean =>
    fs.existsSync(path.join(p, "lists")) &&
    fs.readdirSync(p).some((f) => /^general.*\.bat$/i.test(f));
  if (hasPayload(root)) return root;
  try {
    for (const e of fs.readdirSync(root, { withFileTypes: true })) {
      if (e.isDirectory() && hasPayload(path.join(root, e.name))) return path.join(root, e.name);
    }
  } catch {
    /* нет доступа */
  }
  return null;
}

/**
 * Скачивает и устанавливает свежие конфиги Flowseal поверх текущего каталога
 * движка (там же, где лежит nfqws — см. updateTargetDir()). Пользовательские
 * списки (lists/*-user.txt) и флаг GameFilter сохраняются, как на Windows.
 * Асинхронно, с прогрессом — тот же контракт вызова, что installEngine() в
 * server/zapret.js (installStatus() для поллинга из UI).
 */
export function installEngine(opts: { tag?: string } = {}): typeof installState {
  if (installState.state === "working") return installState;
  installState = { state: "working", progress: 0, phase: "resolve", error: "", tag: opts.tag || null, at: Date.now() };
  const target = updateTargetDir();
  const tmpRoot = path.join(require("os").tmpdir(), `moonapp_zapret_dl_${Date.now()}`);
  (async () => {
    try {
      installState.phase = "stop";
      try {
        await stop();
      } catch {
        /* не запущен */
      }

      installState.phase = "resolve";
      const rel = opts.tag
        ? {
            tag: opts.tag,
            zipName: `zapret-discord-youtube-${opts.tag}.zip`,
            zipUrl: `https://github.com/${GITHUB_REPO}/releases/download/${opts.tag}/zapret-discord-youtube-${opts.tag}.zip`,
          }
        : await fetchLatestRelease(true);
      installState.tag = rel.tag;

      installState.phase = "download";
      fs.mkdirSync(tmpRoot, { recursive: true });
      const zipPath = path.join(tmpRoot, rel.zipName || "release.zip");
      await downloadToFile(rel.zipUrl, zipPath, {
        userAgent: "Mozilla/5.0",
        timeoutMs: 300000,
        onProgress: ({ total, received }: { total: number; received: number }) => {
          installState.progress = total ? Math.min(100, Math.round((100 * received) / total)) : 0;
        },
      });

      installState.phase = "extract";
      installState.progress = 0;
      // eslint-disable-next-line @typescript-eslint/no-require-imports
      const AdmZip = require("adm-zip");
      const raw = path.join(tmpRoot, "raw");
      new AdmZip(zipPath).extractAllTo(raw, true);
      const payload = probePayloadDir(raw);
      if (!payload) throw new Error("payload_not_found_in_release");

      // Сохраняем пользовательские списки + GameFilter текущей установки.
      const keep: Record<string, string> = {};
      let keptGameFilter: string | null = null;
      if (fs.existsSync(target)) {
        for (const name of zapretWin.USER_LISTS) {
          try {
            const p = path.join(target, "lists", name);
            if (fs.existsSync(p)) keep[name] = fs.readFileSync(p, "utf8");
          } catch {
            /* ignore */
          }
        }
        try {
          const gf = zapretWin.gameFilterFile(target);
          if (fs.existsSync(gf)) keptGameFilter = fs.readFileSync(gf, "utf8");
        } catch {
          /* ignore */
        }
      }

      installState.phase = "install";
      fs.mkdirSync(target, { recursive: true });
      // Только нужные части — general*.bat, lists/, utils/ (там GameFilter-флаг).
      for (const name of fs.readdirSync(payload)) {
        if (!isWantedTopLevel(name)) continue;
        const from = path.join(payload, name);
        const to = path.join(target, name);
        if (fs.statSync(from).isDirectory()) copyDirRecursive(from, to);
        else fs.copyFileSync(from, to);
      }
      // bin/ — только *.bin (fake-payload'ы), Windows-бинарники пропускаем.
      copyBinDirFiltered(path.join(payload, "bin"), path.join(target, "bin"));

      for (const [name, content] of Object.entries(keep)) {
        const p = path.join(target, "lists", name);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, content, "utf8");
      }
      if (keptGameFilter !== null) {
        const p = zapretWin.gameFilterFile(target);
        fs.mkdirSync(path.dirname(p), { recursive: true });
        fs.writeFileSync(p, keptGameFilter, "utf8");
      } else {
        zapretWin.writeGameFilter();
      }
      try {
        zapretWin.ensureUserLists(target);
      } catch {
        /* дефолты уже создаются внутри ensureUserLists при ошибке */
      }

      fs.writeFileSync(
        path.join(target, VERSION_FILE),
        JSON.stringify({ tag: rel.tag, installedAt: new Date().toISOString(), source: GITHUB_REPO }, null, 2),
        "utf8",
      );

      installState = { state: "done", progress: 100, phase: "", error: "", tag: rel.tag, at: Date.now() };
      logger.action("zapretLinux.install.done", { tag: rel.tag, dir: target });
    } catch (e) {
      installState = {
        state: "error",
        progress: 0,
        phase: "",
        error: String((e as Error).message || e),
        tag: installState.tag,
        at: Date.now(),
      };
      logger.error("zapretLinux.install.error", { error: installState.error });
    } finally {
      try {
        fs.rmSync(tmpRoot, { recursive: true, force: true });
      } catch {
        /* временная папка, не критично */
      }
    }
  })();
  return installState;
}

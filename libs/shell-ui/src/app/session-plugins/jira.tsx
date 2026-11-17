import { appRuntime } from '../appRuntime';
import { axnLog } from '../log';
import type { PluginSettings, PluginSettingsSection } from '../pluginSettings';
import { shellQuote } from '../../shellQuote';
import {
  ChipView,
  peekEnrichment,
  registerCardEnricher,
  resolveChipColor,
  useEnrichedKeys,
  type CardChip,
  type CardEnrichment,
  type CardSubject,
} from './cardEnrichers';
import type { PluginApi, SessionViewContext, SessionViewPlugin } from './plugin';
import { registerTicketSource, type Ticket } from './ticketSources';

/**
 * Jira plugin — first slice: a card enricher only. Cards whose MR title,
 * branch, workflow vars or session name carry an issue key of a configured
 * project get a status chip (summary/assignee in the tooltip, click opens
 * the issue) and `jira.*` fields.
 *
 * Requests run through the app runtime's `exec` (`sh -c` on the desktop or
 * the session host), so the plugin works on remote backends too and dodges
 * Jira's CORS. The token never lands in curl's argv: the script captures it
 * in a shell variable — from the literal `token` setting or the OS keychain
 * (`security` on macOS, `secret-tool` on Linux) — and hands curl its config
 * on stdin (`curl -K -`).
 */

export const DEFAULT_KEYCHAIN_SERVICE = 'axn-term-jira';
/** Jira's bulk fetch accepts at most 100 issues per call. */
const BULK_LIMIT = 100;
const FIELDS = ['summary', 'status', 'assignee', 'issuetype'];

export type JiraAuth =
  | { kind: 'token'; value: string }
  | { kind: 'keychain'; service: string; account: string };

export interface JiraConfig {
  baseUrl: string;
  email: string;
  projectKeys: string[];
  auth: JiraAuth;
  /**
   * `status-colors`: lowercased status name or status-category key (`new`,
   * `indeterminate`, `done`) → a chip color (named or hex). Empty = the
   * category defaults.
   */
  statusColors: Record<string, string>;
}

const str = (v: unknown): string => (typeof v === 'string' ? v.trim() : '');

/** `AIACC, mgnl` / `AIACC MGNL` / a YAML list → `['AIACC', 'MGNL']`. */
export function parseProjectKeys(raw: unknown): string[] {
  const parts = Array.isArray(raw) ? raw.map(String) : str(raw).split(/[\s,;]+/);
  return [
    ...new Set(
      parts.map((p) => p.trim().toUpperCase()).filter((p) => /^[A-Z][A-Z0-9_]+$/.test(p)),
    ),
  ];
}

/**
 * `status-colors` → lowercased key → color. Accepts a YAML map
 * (`In Progress: blue`) or the one-line form the Settings field writes
 * (`In Progress: blue; Reviewed: #8e44ad`, `;` or newline separated, `:` or
 * `=` between name and color). Keys are status names or the status-category
 * keys `new`/`indeterminate`/`done`; values are named chip colors or hex —
 * anything else is dropped.
 */
export function parseStatusColors(raw: unknown): Record<string, string> {
  const pairs: [string, unknown][] =
    raw && typeof raw === 'object' && !Array.isArray(raw)
      ? Object.entries(raw as Record<string, unknown>)
      : str(raw)
          .split(/[;\n]/)
          .map((part) => /^\s*(.+?)\s*[:=]\s*(\S+)\s*$/.exec(part))
          .filter((m): m is RegExpExecArray => !!m)
          .map((m) => [m[1], m[2]]);
  const out: Record<string, string> = {};
  for (const [name, value] of pairs) {
    const key = name.trim().toLowerCase();
    if (key && typeof value === 'string' && resolveChipColor(value)) out[key] = value.trim().toLowerCase();
  }
  return out;
}

/** The configured color for a status: exact status name first, then its category. */
export function statusColor(
  colors: Record<string, string> | undefined,
  status: string,
  category: string,
): string | undefined {
  if (!colors) return undefined;
  return colors[status.trim().toLowerCase()] ?? colors[category.trim().toLowerCase()];
}

export type JiraConfigResult = { ok: true; config: JiraConfig } | { ok: false; reason: string };

/** Validate the plugins.yaml `jira` section into a usable config. */
export function jiraConfig(section: PluginSettingsSection | undefined): JiraConfigResult {
  if (!section || section.enabled !== true) return { ok: false, reason: 'disabled' };
  const baseUrl = str(section.baseUrl).replace(/\/+$/, '');
  if (!/^https:\/\//.test(baseUrl)) return { ok: false, reason: 'base-url must be an https:// URL' };
  const email = str(section.email);
  if (!email) return { ok: false, reason: 'email is not set' };
  const projectKeys = parseProjectKeys(section.projectKeys);
  if (projectKeys.length === 0) return { ok: false, reason: 'project-keys is empty' };
  const token = str(section.token);
  const tokenFrom = str(section.tokenFrom).toLowerCase();
  if (token && tokenFrom) {
    return { ok: false, reason: 'set either token or token-from, not both' };
  }
  let auth: JiraAuth;
  if (tokenFrom === 'keychain') {
    auth = {
      kind: 'keychain',
      service: str(section.keychainService) || DEFAULT_KEYCHAIN_SERVICE,
      account: str(section.keychainAccount) || email,
    };
  } else if (tokenFrom) {
    return { ok: false, reason: `unknown token-from '${tokenFrom}' (supported: keychain)` };
  } else if (token) {
    auth = { kind: 'token', value: token };
  } else {
    return { ok: false, reason: 'no token: set token or token-from: keychain' };
  }
  return {
    ok: true,
    config: { baseUrl, email, projectKeys, auth, statusColors: parseStatusColors(section.statusColors) },
  };
}

/** First issue key of a configured project in `text` (case-insensitive, uppercased). */
export function findIssueKey(text: string | undefined, projectKeys: string[]): string | undefined {
  if (!text || projectKeys.length === 0) return undefined;
  const alt = projectKeys.map((k) => k.replace(/[^A-Z0-9_]/g, '')).join('|');
  // Not glued to a longer word on the left (`XAIACC-1`), not a longer
  // number on the right — `_`/`/`/`-` around it are fine (branch names).
  const re = new RegExp(`(?<![A-Za-z0-9])(${alt})-(\\d+)(?!\\d)`, 'i');
  const m = re.exec(text);
  return m ? `${m[1].toUpperCase()}-${m[2]}` : undefined;
}

/** Every distinct issue key of a configured project in `text`, in order. */
export function findIssueKeys(text: string | undefined, projectKeys: string[]): string[] {
  if (!text || projectKeys.length === 0) return [];
  const alt = projectKeys.map((k) => k.replace(/[^A-Z0-9_]/g, '')).join('|');
  const re = new RegExp(`(?<![A-Za-z0-9])(${alt})-(\\d+)(?!\\d)`, 'gi');
  const out: string[] = [];
  for (const m of text.matchAll(re)) {
    const key = `${m[1].toUpperCase()}-${m[2]}`;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

/** What a session offers for ticket derivation (see `sessionTicketKeys`). */
export interface SessionTicketSources {
  /** Titles of the session's MRs/PRs (glab-mr / gh-pr per-session state). */
  mrTitles: string[];
  branch?: string | null;
  name?: string;
  /** The session's working directory — its basename is the last resort. */
  cwd?: string;
}

/**
 * Ticket keys of a session, tried in order: its MR/PR titles, then the
 * branch, then the session name (custom, else terminal-reported), then the
 * cwd's folder name — the first source yielding any key wins (it may yield
 * several), so a stale name never adds noise to a branch.
 */
export function sessionTicketKeys(src: SessionTicketSources, projectKeys: string[]): string[] {
  const fromTitles = [...new Set(src.mrTitles.flatMap((t) => findIssueKeys(t, projectKeys)))];
  if (fromTitles.length) return fromTitles;
  const fromBranch = findIssueKeys(src.branch ?? undefined, projectKeys);
  if (fromBranch.length) return fromBranch;
  const fromName = findIssueKeys(src.name, projectKeys);
  if (fromName.length) return fromName;
  return findIssueKeys(basename(src.cwd), projectKeys);
}

/** Read the MR/PR titles the forge plugins stored on the session. */
export function sessionMrTitles(pluginState: Record<string, unknown> | undefined): string[] {
  const titles: string[] = [];
  for (const [plugin, field] of [
    ['glab-mr', 'mrs'],
    ['gh-pr', 'prs'],
  ] as const) {
    const list = (pluginState?.[plugin] as Record<string, unknown> | undefined)?.[field];
    if (!Array.isArray(list)) continue;
    for (const item of list) {
      const title = (item as { title?: unknown } | null)?.title;
      if (typeof title === 'string' && title) titles.push(title);
    }
  }
  return titles;
}

const basename = (p: string | undefined) => p?.replace(/\/+$/, '').split('/').pop();

/** Subject → issue key: MR title, branch, workflow vars, then the session. */
export function matchSubject(subject: CardSubject, projectKeys: string[]): string | undefined {
  const candidates = [
    subject.mr?.title,
    subject.mr?.sourceBranch,
    subject.vars?.ticket,
    ...Object.values(subject.vars ?? {}),
    subject.session?.branch,
    subject.session?.name,
    basename(subject.session?.cwd),
  ];
  for (const c of candidates) {
    const key = findIssueKey(c, projectKeys);
    if (key) return key;
  }
  return undefined;
}

/** Escape a value for a double-quoted curl config string. */
function curlInner(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r')
    .replace(/\t/g, '\\t');
}

/** Escape literal text for an unquoted heredoc (`\`, `$`, backtick). */
function heredocLiteral(value: string): string {
  return value.replace(/[\\$`]/g, (c) => `\\${c}`);
}

/**
 * `sh` script that POSTs `body` (JSON) to `url` with basic auth and prints
 * the response body, a newline, and the HTTP status. Pure, for tests.
 */
export function buildRequestScript(config: JiraConfig, path: string, body: string): string {
  const auth = config.auth;
  const tokenLine =
    auth.kind === 'token'
      ? `tok=${shellQuote(auth.value)}`
      : `tok=$(security find-generic-password -s ${shellQuote(auth.service)} -a ${shellQuote(auth.account)} -w 2>/dev/null || secret-tool lookup service ${shellQuote(auth.service)} account ${shellQuote(auth.account)} 2>/dev/null)`;
  const missing =
    auth.kind === 'keychain'
      ? `no keychain entry for service ${auth.service}, account ${auth.account}`
      : 'empty token';
  const lit = (line: string) => heredocLiteral(line);
  const cfg = [
    lit(`url = "${curlInner(config.baseUrl + path)}"`),
    // `${tok}` stays unescaped so the heredoc expands it; the token was
    // curl-escaped above, the email is escaped here.
    `user = "${heredocLiteral(curlInner(config.email))}:\${tok}"`,
    lit('request = "POST"'),
    lit('header = "Accept: application/json"'),
    lit('header = "Content-Type: application/json"'),
    lit(`data-raw = "${curlInner(body)}"`),
    lit('silent'),
    lit('show-error'),
    lit('max-time = 30'),
    lit('write-out = "\\n%{http_code}"'),
  ];
  return [
    tokenLine,
    `[ -n "$tok" ] || { echo ${shellQuote(`axn-term: ${missing}`)} >&2; exit 3; }`,
    `tok=$(printf '%s' "$tok" | sed 's/[\\\\"]/\\\\&/g')`,
    'curl -K - <<AXN_JIRA_CFG',
    ...cfg,
    'AXN_JIRA_CFG',
  ].join('\n');
}

/** Split the script's stdout into status + body. */
export function splitStatus(stdout: string): { status: number; body: string } | undefined {
  const trimmed = stdout.replace(/\s+$/, '');
  const nl = trimmed.lastIndexOf('\n');
  const code = Number(trimmed.slice(nl + 1));
  if (!Number.isInteger(code) || code < 100) return undefined;
  return { status: code, body: nl >= 0 ? trimmed.slice(0, nl) : '' };
}

export interface JiraIssue {
  key: string;
  fields?: {
    summary?: string;
    status?: { name?: string; statusCategory?: { key?: string } };
    assignee?: { displayName?: string } | null;
    issuetype?: { name?: string };
  };
}

const TONE_BY_CATEGORY: Record<string, CardChip['tone']> = {
  new: 'neutral',
  indeterminate: 'progress',
  done: 'done',
};

/** Default chip color per status category, as a named color (tickets carry it). */
const COLOR_BY_CATEGORY: Record<string, string> = {
  new: 'gray',
  indeterminate: 'yellow',
  done: 'green',
};

/** One issue → its card enrichment. */
export function issueEnrichment(
  issue: JiraIssue,
  baseUrl: string,
  colors?: Record<string, string>,
): CardEnrichment {
  const f = issue.fields ?? {};
  const status = f.status?.name ?? '';
  const category = f.status?.statusCategory?.key ?? '';
  const assignee = f.assignee?.displayName ?? 'Unassigned';
  const type = f.issuetype?.name ?? '';
  const url = `${baseUrl}/browse/${issue.key}`;
  const tip = [f.summary, [type, assignee].filter(Boolean).join(' · ')].filter(Boolean).join('\n');
  return {
    chips: [
      {
        label: status ? `${issue.key} · ${status}` : issue.key,
        tip,
        href: url,
        tone: TONE_BY_CATEGORY[category] ?? 'neutral',
        color: statusColor(colors, status, category),
      },
    ],
    fields: {
      'jira.key': issue.key,
      'jira.summary': f.summary ?? '',
      'jira.status': status,
      'jira.statusCategory': category,
      'jira.assignee': f.assignee?.displayName ?? '',
      'jira.type': type,
      'jira.url': url,
    },
  };
}

/** Parse a bulkfetch response into enrichments keyed by issue key. */
export function parseBulkFetch(
  body: string,
  baseUrl: string,
  colors?: Record<string, string>,
): Record<string, CardEnrichment> {
  const data = JSON.parse(body) as { issues?: JiraIssue[] };
  const out: Record<string, CardEnrichment> = {};
  for (const issue of data.issues ?? []) {
    if (issue?.key) out[issue.key.toUpperCase()] = issueEnrichment(issue, baseUrl, colors);
  }
  return out;
}

let lastReported: string | undefined;
/** Log a config/request problem once per distinct message. */
function report(message: string): void {
  if (message === lastReported) return;
  lastReported = message;
  axnLog('warn', 'jira', message);
}

/** POST a JSON body through the exec host; parsed JSON, or a thrown error. */
async function jiraPost(config: JiraConfig, path: string, body: unknown): Promise<unknown> {
  const runtime = appRuntime();
  if (!runtime) throw new Error('jira: no exec host');
  let stdout: string;
  try {
    stdout = await runtime.exec(buildRequestScript(config, path, JSON.stringify(body)));
  } catch (e) {
    report(`request failed: ${String(e instanceof Error ? e.message : e).slice(0, 300)}`);
    throw e;
  }
  const res = splitStatus(stdout);
  if (!res) {
    report('unexpected response (no HTTP status)');
    throw new Error('jira: no status');
  }
  if (res.status === 401 || res.status === 403) {
    report(`authentication failed (HTTP ${res.status}) — check email and token`);
    throw new Error(`jira: HTTP ${res.status}`);
  }
  if (res.status !== 200) {
    report(`HTTP ${res.status}: ${res.body.slice(0, 200)}`);
    throw new Error(`jira: HTTP ${res.status}: ${res.body.slice(0, 200)}`);
  }
  lastReported = undefined;
  return JSON.parse(res.body);
}

async function fetchIssues(
  config: JiraConfig,
  keys: string[],
): Promise<Record<string, CardEnrichment>> {
  if (!appRuntime()) return {};
  const out: Record<string, CardEnrichment> = {};
  for (let i = 0; i < keys.length; i += BULK_LIMIT) {
    const chunk = keys.slice(i, i + BULK_LIMIT);
    const data = await jiraPost(config, '/rest/api/3/issue/bulkfetch', {
      issueIdsOrKeys: chunk,
      fields: FIELDS,
    });
    Object.assign(out, parseBulkFetch(JSON.stringify(data), config.baseUrl, config.statusColors));
  }
  return out;
}

/** Most tickets a backlog query returns (one page). */
export const SEARCH_LIMIT = 50;

/** One issue → a ticket-source `Ticket`. */
export function issueToTicket(
  issue: JiraIssue,
  baseUrl: string,
  colors?: Record<string, string>,
): Ticket {
  const f = issue.fields ?? {};
  const status = f.status?.name ?? '';
  const category = f.status?.statusCategory?.key ?? '';
  return {
    key: issue.key.toUpperCase(),
    summary: f.summary ?? '',
    status: f.status?.name ?? '',
    statusCategory: f.status?.statusCategory?.key ?? '',
    url: `${baseUrl}/browse/${issue.key}`,
    assignee: f.assignee?.displayName ?? undefined,
    type: f.issuetype?.name ?? undefined,
    color: statusColor(colors, status, category) ?? COLOR_BY_CATEGORY[category] ?? 'gray',
  };
}

/** Parse a `/search/jql` response into tickets. */
export function parseSearch(
  data: unknown,
  baseUrl: string,
  colors?: Record<string, string>,
): Ticket[] {
  const issues = (data as { issues?: JiraIssue[] } | undefined)?.issues ?? [];
  return issues.filter((i) => i?.key).map((i) => issueToTicket(i, baseUrl, colors));
}

async function searchIssues(config: JiraConfig, jql: string): Promise<Ticket[]> {
  const data = await jiraPost(config, '/rest/api/3/search/jql', {
    jql,
    fields: FIELDS,
    maxResults: SEARCH_LIMIT,
  });
  return parseSearch(data, config.baseUrl, config.statusColors);
}

/** What cached Jira results depend on — a change re-fetches them. */
function jiraSettingsKey(settings: PluginSettings): string {
  const config = configFrom(settings);
  return config ? `${config.baseUrl}|${JSON.stringify(config.statusColors)}` : '';
}

function configFrom(settings: PluginSettings): JiraConfig | undefined {
  const result = jiraConfig(settings.jira);
  if (result.ok) return result.config;
  if (result.reason !== 'disabled') report(`not active: ${result.reason}`);
  return undefined;
}

registerCardEnricher({
  id: 'jira',
  enabled: (settings) => configFrom(settings) !== undefined,
  match: (subject, settings) => {
    const config = configFrom(settings);
    return config ? matchSubject(subject, config.projectKeys) : undefined;
  },
  enrich: async (keys, settings) => {
    const config = configFrom(settings);
    return config ? fetchIssues(config, keys) : {};
  },
  settingsKey: jiraSettingsKey,
});

registerTicketSource({
  id: 'jira',
  enabled: (settings) => configFrom(settings) !== undefined,
  search: async (query, settings) => {
    const config = configFrom(settings);
    return config ? searchIssues(config, query) : [];
  },
  settingsKey: jiraSettingsKey,
});

/**
 * A session's tickets as chips — `KEY · Status` once the bulk fetch lands,
 * the bare key until then (or for keys Jira does not know).
 */
function SessionTickets({ keys }: { keys: string[] }) {
  const enriched = useEnrichedKeys('jira', keys);
  // Jira answered without a key: not a real ticket (a folder like
  // ai-accelerator-1 reads as ACCELERATOR-1) — show nothing for it.
  const visible = keys.filter((key) => enriched[key] !== null);
  if (visible.length === 0) return null;
  return (
    <span className="flex min-w-0 flex-wrap items-center gap-1">
      {visible.map((key) => {
        const chip = enriched[key]?.chips?.[0] ?? { label: key, tone: 'neutral' as const };
        return <ChipView key={key} chip={chip} />;
      })}
    </span>
  );
}

/** The session's ticket keys when the plugin is active, else none. */
function ticketsOf(ctx: SessionViewContext & PluginApi): string[] {
  const result = jiraConfig(ctx.pluginSettings as PluginSettingsSection | undefined);
  if (!result.ok) return [];
  const s = ctx.session;
  return sessionTicketKeys(
    {
      mrTitles: sessionMrTitles(s.pluginState as Record<string, unknown> | undefined),
      branch: s.repo?.branch,
      // The custom name, else the terminal-reported one (an agent's title).
      name: s.name?.trim() || s.autoName,
      cwd: s.cwd,
    },
    result.config.projectKeys,
  );
}

export const jiraPlugin: SessionViewPlugin = {
  id: 'jira',
  title: 'Jira',
  logo: 'Ticket',
  version: '0.1.0',
  defaultEnabled: false,
  sessionFields: [
    {
      id: 'tickets',
      label: 'Jira tickets',
      kind: 'inline',
      zone: 'always',
      optIn: true,
      // Searchable: the keys, plus status and summary once fetched; keys
      // Jira does not know are not shown, so they do not match either.
      search: (ctx) =>
        ticketsOf(ctx).flatMap((key) => {
          const e = peekEnrichment('jira', key);
          if (e === null) return [];
          return [key, e?.fields?.['jira.status'] ?? '', e?.fields?.['jira.summary'] ?? ''];
        }),
      value: (ctx) => {
        const keys = ticketsOf(ctx);
        return keys.length ? <SessionTickets keys={keys} /> : null;
      },
    },
  ],
  settings: [
    {
      key: 'baseUrl',
      label: 'Jira URL',
      description: 'e.g. https://your-site.atlassian.net',
      type: 'string',
    },
    {
      key: 'email',
      label: 'Account email',
      description: 'The Atlassian account the API token belongs to.',
      type: 'string',
    },
    {
      key: 'projectKeys',
      label: 'Project keys',
      description:
        'Comma-separated (e.g. AIACC, MGNL). Only keys of these projects are looked up, so text like UTF-8 never matches.',
      type: 'string',
    },
    {
      key: 'tokenFrom',
      label: 'Token source',
      description: 'Where the API token comes from. Set either a token here or use the keychain — not both.',
      type: 'string',
      options: [
        { value: '', label: 'Token below (stored in plugins.yaml)' },
        { value: 'keychain', label: 'OS keychain' },
      ],
      default: '',
    },
    {
      key: 'token',
      label: 'API token',
      description: 'Stored in plain text in ~/.axn-term/plugins.yaml. Leave empty when using the keychain.',
      type: 'string',
      secret: true,
    },
    {
      key: 'keychainService',
      label: 'Keychain service',
      description: `Keychain item service name (default: ${DEFAULT_KEYCHAIN_SERVICE}). macOS: security add-generic-password -s ${DEFAULT_KEYCHAIN_SERVICE} -a <email> -w`,
      type: 'string',
    },
    {
      key: 'keychainAccount',
      label: 'Keychain account',
      description: 'Keychain item account (default: the account email).',
      type: 'string',
    },
    {
      key: 'statusColors',
      label: 'Status colors',
      description:
        'Chip color per status, e.g. "In Progress: blue; Reviewed: #8e44ad; Reopened: red". Keys: a status name or a category (new, indeterminate, done). Colors: gray, blue, cyan, green, yellow, orange, red, violet, magenta, accent — or any hex. Unset statuses use their category (to do gray, in progress yellow, done green).',
      type: 'string',
    },
  ],
};

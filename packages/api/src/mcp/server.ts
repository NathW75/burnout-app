/**
 * The AI connector endpoint (PRD-011 §4, §7): POST /mcp, JSON-RPC over
 * stateless Streamable HTTP. The official SDK (v2) serves both 2026-07-28
 * requests and 2025-era `initialize` clients, and checks the Mcp-Method /
 * Mcp-Name headers. This file adds what the SDK leaves to us: the Origin
 * check, MCP-only bearer auth, per-credential and per-user rate limits, and
 * READ ONLY tool handlers.
 */
import { createMcpHandler, fromJsonSchema, McpServer, type JsonSchemaType, type McpRequestContext } from '@modelcontextprotocol/server';
import express, { type Request, type Response, type Router } from 'express';
import type { ApiContext } from '../context';
import { verifyBearer, type McpPrincipal } from './credentials';
import { getBurnHistory, getFieldBurnRates, getMyPool, getPoolStandings, readOnly, ToolError } from './tools';

export const MCP_SERVER_INFO = { name: 'burnout-league', version: '1.0.0' };

/** Per credential, per minute (PRD-011 §7). */
export const TOOL_LIMITS: Record<string, number> = {
  get_my_pool: 60,
  get_burn_history: 60,
  get_pool_standings: 30,
  get_field_burn_rates: 30,
};
export const USER_LIMIT_PER_MIN = 120;

const POSITIONS = ['QB', 'RB', 'FB', 'WR', 'TE', 'K'];
const READ_ONLY = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false };
const uuidSchema = { type: 'string', pattern: '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$' };
const week = { type: 'integer', minimum: 1, maximum: 18 };
const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });
/** Outputs: the documented fields are required; extra fields are allowed so additions don't break clients. */
const out = (properties: Record<string, unknown>, required: string[]) => ({ type: 'object', properties, required });

const TOOLS = [
  {
    name: 'get_my_pool',
    title: 'My player pool',
    description:
      'Your Burnout League player universe for the season, by state: available (selectable now), unavailable (Out/IR, no game this week, or game already started), locked_pending_final (locked, game not Final yet: not burned yet), burned (permanently used). Lists are sorted by points so far this season and capped by `limit`; the summary counts everything. Also returns your lineup for the current week, locked or not.',
    input: obj({
      position: { type: 'string', enum: POSITIONS, description: 'Only this position.' },
      week: { ...week, description: 'State as of this week (default: the current week).' },
      state: { type: 'string', enum: ['available', 'unavailable', 'locked_pending_final', 'burned'], description: 'Only this list.' },
      limit: { type: 'integer', minimum: 1, maximum: 300, description: 'Players per list (default 50).' },
    }),
    output: out({ season: { type: 'string' }, week: { type: 'integer' }, summary: { type: 'object' }, players: { type: 'object' }, my_lineup_this_week: { type: 'object' } }, ['season', 'week', 'summary', 'players', 'my_lineup_this_week']),
    limit: TOOL_LIMITS.get_my_pool,
    run: (ctx: ApiContext, userId: string, a: Record<string, unknown>) => getMyPool(ctx, userId, a),
    text: (r: Awaited<ReturnType<typeof getMyPool>>) =>
      `Week ${r.week}: ${r.summary.total_available} available, ${r.summary.total_unavailable} unavailable, ${r.summary.total_locked_pending_final} locked (not Final), ${r.summary.total_burned} burned.`,
  },
  {
    name: 'get_burn_history',
    title: 'My burn history',
    description:
      'Every player you have burned this season: slot, week, when you submitted, when it locked, when it burned, and the points scored. field_start_rate_at_lock is the share of the field that started the same player that week, shown only when that week had at least 50 managers.',
    input: obj({ week: { ...week, description: 'Only this week.' }, position: { type: 'string', enum: POSITIONS, description: 'Only this position.' } }),
    output: out({ season: { type: 'string' }, burns: { type: 'array' }, summary: { type: 'object' } }, ['season', 'burns', 'summary']),
    limit: TOOL_LIMITS.get_burn_history,
    run: (ctx: ApiContext, userId: string, a: Record<string, unknown>) => getBurnHistory(ctx, userId, a),
    text: (r: Awaited<ReturnType<typeof getBurnHistory>>) =>
      `${r.summary.total_burns} burns, ${r.summary.total_points} points${r.summary.avg_points_per_burn !== null ? ` (${r.summary.avg_points_per_burn} per burn)` : ''}.`,
  },
  {
    name: 'get_pool_standings',
    title: 'Standings',
    description:
      'Standings for every contest pool you have entered (the same board as the app: rank, handle, season and week points, rank change), plus the season field board everyone sees. Pools you have not entered are not readable.',
    input: obj({ pool_id: { ...uuidSchema, description: 'Only this pool.' } }),
    output: out({ season: { type: 'string' }, free_play: { type: 'boolean' }, pools: { type: 'array' }, season_field: { type: 'object' } }, ['season', 'free_play', 'pools', 'season_field']),
    limit: TOOL_LIMITS.get_pool_standings,
    run: (ctx: ApiContext, userId: string, a: Record<string, unknown>) => getPoolStandings(ctx, userId, a),
    text: (r: Awaited<ReturnType<typeof getPoolStandings>>) =>
      `${r.pools.length ? `${r.pools.length} pool(s).` : 'No paid pools entered (free play).'} Season field: ${r.season_field.my_rank !== null ? `you're #${r.season_field.my_rank} of ${r.season_field.field_size}` : `${r.season_field.field_size} managers`}.`,
  },
  {
    name: 'get_field_burn_rates',
    title: 'Field burn rates',
    description:
      'What share of the field has burned each player, through a week and in that week, with whether you have burned him or still have him. Uses locked picks and recorded burns only, never anyone’s unlocked picks. Returns figures only when the field has at least 50 managers (otherwise field_below_minimum is true); rates are whole percentages.',
    input: obj({
      scope: { type: 'string', enum: ['season', 'pool'], description: 'season (default): everyone with a season lineup. pool: one pool you entered.' },
      pool_id: { ...uuidSchema, description: 'Required when scope is pool.' },
      position: { type: 'string', enum: POSITIONS },
      week: { ...week, description: 'Through this week (default: the latest week with burns).' },
      top_n: { type: 'integer', minimum: 1, maximum: 100, description: 'Players returned (default 20).' },
    }),
    output: out({ season: { type: 'string' }, scope: { type: 'string' }, week: { type: 'integer' }, field_below_minimum: { type: 'boolean' } }, ['season', 'scope', 'week', 'field_below_minimum']),
    limit: TOOL_LIMITS.get_field_burn_rates,
    run: (ctx: ApiContext, userId: string, a: Record<string, unknown>) => getFieldBurnRates(ctx, userId, a),
    text: (r: Awaited<ReturnType<typeof getFieldBurnRates>>) =>
      r.field_below_minimum ? `The field is under ${50} managers, so no rates are shown (they would identify people).` : `Field of about ${'field_size' in r ? r.field_size : 0} managers through week ${r.week}.`,
  },
] as const;

export const TOOL_NAMES = TOOLS.map((t) => t.name);

function buildServer(ctx: ApiContext, userId: string): McpServer {
  const server = new McpServer(MCP_SERVER_INFO, {
    instructions:
      'Burnout League data for the signed-in manager: their player pool and burns, standings, and anonymized field burn rates. Read-only: lineups are submitted only by the manager in the app. Players are text only.',
    cacheHints: { 'tools/list': { ttlMs: 3_600_000, cacheScope: 'private' } },
  });
  for (const t of TOOLS) {
    server.registerTool(
      t.name,
      { title: t.title, description: t.description, inputSchema: fromJsonSchema(t.input as JsonSchemaType), outputSchema: fromJsonSchema(t.output as JsonSchemaType), annotations: READ_ONLY },
      async (args: unknown) => {
        try {
          const result = await readOnly(ctx, (ro) => (t.run as (c: ApiContext, u: string, a: Record<string, unknown>) => Promise<object>)(ro, userId, (args ?? {}) as Record<string, unknown>));
          return {
            content: [{ type: 'text' as const, text: `${(t.text as (r: object) => string)(result)}\n\n${JSON.stringify(result)}` }],
            structuredContent: result as Record<string, unknown>,
          };
        } catch (err) {
          if (err instanceof ToolError) return { content: [{ type: 'text' as const, text: err.message }], isError: true };
          throw err;
        }
      }
    );
  }
  return server;
}

/** JSON-RPC error with an HTTP status (rate limits, auth). */
function rpcError(res: Response, status: number, id: unknown, code: number, message: string, data?: object) {
  res.status(status).json({ jsonrpc: '2.0', id: id ?? null, error: { code, message, ...(data ? { data } : {}) } });
}

export function mcpRouter(ctx: ApiContext): Router {
  const handler = createMcpHandler(
    (rc: McpRequestContext) => {
      const userId = (rc.authInfo?.extra as { userId?: string } | undefined)?.userId;
      if (!userId) throw new Error('MCP request without an authenticated user');
      return buildServer(ctx, userId);
    },
    { legacy: 'stateless', onerror: (err) => ctx.log('warn', 'mcp request rejected', { error: err.message }) }
  );
  const r = express.Router();

  r.all('/', async (req: Request, res: Response, next) => {
    try {
      // Browsers only: a request carrying an Origin must come from one we serve (DNS-rebinding guard).
      const origin = req.get('origin');
      if (origin && !ctx.config.corsOrigins.includes(origin)) return rpcError(res, 403, null, -32600, 'Origin not allowed');
      if (req.method !== 'POST') return res.status(405).set('Allow', 'POST').json({ jsonrpc: '2.0', id: null, error: { code: -32600, message: 'Method not allowed.' } });

      // Only MCP credentials work here; session cookies and session tokens never do (PRD-011 §5.4).
      const principal: McpPrincipal | null = await verifyBearer(ctx, req.get('authorization'));
      const body = req.body as { id?: unknown; method?: unknown; params?: { name?: unknown } } | undefined;
      if (!principal) {
        res.set('WWW-Authenticate', 'Bearer realm="Burnout League", error="invalid_token"');
        return rpcError(res, 401, body?.id, -32000, 'A valid Burnout League connector token is required.');
      }

      // Rate limits on tool calls: per credential per tool, and per user across credentials.
      if (body?.method === 'tools/call' && typeof body.params?.name === 'string' && body.params.name in TOOL_LIMITS) {
        const tool = body.params.name;
        const okCred = await ctx.limiter.hit(`mcp:cred:${principal.credentialId}:${tool}`, TOOL_LIMITS[tool], 60);
        const okUser = okCred && (await ctx.limiter.hit(`mcp:user:${principal.userId}`, USER_LIMIT_PER_MIN, 60));
        if (!okCred || !okUser) {
          res.set('Retry-After', '60');
          return rpcError(res, 429, body.id, -32000, 'Rate limit reached. Try again in a minute.', { retryAfterSeconds: 60 });
        }
      }

      const started = Date.now();
      const url = new URL(req.originalUrl, `https://${req.get('host') ?? 'localhost'}`);
      const headers = new Headers();
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers.set(k, v);
        else if (Array.isArray(v)) headers.set(k, v.join(', '));
      }
      const webReq = new Request(url, { method: 'POST', headers, body: JSON.stringify(req.body ?? null) });
      const webRes = await handler.fetch(webReq, {
        parsedBody: req.body,
        authInfo: { token: principal.credentialId, clientId: principal.credentialId, scopes: [principal.scope], extra: { userId: principal.userId } },
      });
      res.status(webRes.status);
      webRes.headers.forEach((v, k) => {
        if (k !== 'content-length' && k !== 'transfer-encoding') res.setHeader(k, v);
      });
      const text = await webRes.text();
      // Outputs are never logged (PRD-011 §10.4): the method, tool, credential, timing and size only.
      ctx.log('info', 'mcp', {
        method: typeof body?.method === 'string' ? body.method : null,
        tool: body?.method === 'tools/call' && typeof body.params?.name === 'string' ? body.params.name : null,
        credentialId: principal.credentialId, status: webRes.status, ms: Date.now() - started, bytes: text.length,
      });
      res.send(text);
    } catch (err) {
      next(err);
    }
  });
  return r;
}

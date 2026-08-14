import Handlebars from 'handlebars';
import fs from 'fs';
import path from 'path';
import type { FastifyReply } from 'fastify';
import { getCachedUpdateStatus } from './updates';
import config from '../config';

const ADMIN_VIEWS = path.resolve(process.cwd(), 'admin');

// A deep link to GitHub's "new issue" form, pre-filled as a feature request.
// No API token to manage per store — the owner files it under their own GitHub
// account, so the link works the same for a self-hosted or a managed store.
const FEATURE_REQUEST_URL =
  'https://github.com/Squaark/squaark/issues/new?labels=enhancement'
  + '&title=' + encodeURIComponent('Feature request: ')
  + '&body=' + encodeURIComponent(
      '### What would you like to add or change?\n\n\n'
    + '### Why would it help your store?\n\n\n'
    + '---\nSent from the Squaark admin.',
    );

const hbs = Handlebars.create();

function loadPartials() {
  const partialsDir = path.join(ADMIN_VIEWS, 'partials');
  if (!fs.existsSync(partialsDir)) return;
  for (const file of fs.readdirSync(partialsDir)) {
    if (!file.endsWith('.hbs')) continue;
    const name = path.basename(file, '.hbs');
    hbs.registerPartial(name, fs.readFileSync(path.join(partialsDir, file), 'utf-8'));
  }
}

loadPartials();

hbs.registerHelper('csrf_field', function (this: { csrfToken?: string }, options: Handlebars.HelperOptions) {
  // Fall back to the root context — inside an {{#each}} block `this` is the loop
  // item, which has no csrfToken, so a naive `this.csrfToken` would render an
  // empty token and every form in the loop would fail the CSRF check.
  const token = Handlebars.escapeExpression(this?.csrfToken ?? options?.data?.root?.csrfToken ?? '');
  return new Handlebars.SafeString(`<input type="hidden" name="_csrf" value="${token}">`);
});

hbs.registerHelper('eq', (a: unknown, b: unknown) => a === b);
hbs.registerHelper('ne', (a: unknown, b: unknown) => a !== b);
hbs.registerHelper('or', (a: unknown, b: unknown) => a || b);
hbs.registerHelper('and', (a: unknown, b: unknown) => a && b);
hbs.registerHelper('not', (a: unknown) => !a);
hbs.registerHelper('gt', (a: number, b: number) => a > b);
hbs.registerHelper('lt', (a: number, b: number) => a < b);
hbs.registerHelper('add', (a: number, b: number) => a + b);
hbs.registerHelper('subtract', (a: number, b: number) => a - b);
hbs.registerHelper('concat', (...args: unknown[]) => args.slice(0, -1).join(''));
hbs.registerHelper('lookup', (obj: Record<string, unknown>, key: string) => obj?.[key]);
hbs.registerHelper('money_pence', (pence: number) => (pence / 100).toFixed(2));
hbs.registerHelper('pence', (amount: number | null | undefined, options: Handlebars.HelperOptions) => {
  if (amount == null) return '—';
  const settings = (options?.data?.root as Record<string, unknown>)?.settings as Record<string, string> | undefined;
  const currencyCode = settings?.store_currency ?? 'GBP';
  const symbols: Record<string, string> = { GBP: '£', USD: '$', EUR: '€' };
  const sym = symbols[currencyCode] ?? currencyCode;
  return `${sym}${(amount / 100).toFixed(2)}`;
});
hbs.registerHelper('isSelected', (code: string, selected: string[]) =>
  Array.isArray(selected) && selected.includes(code),
);
hbs.registerHelper('date_short', (d: string) =>
  new Date(d).toLocaleDateString('en-GB', { day: '2-digit', month: 'short', year: 'numeric' }),
);
hbs.registerHelper('truncate', (text: string, length: number) => {
  if (!text || text.length <= length) return text;
  return text.slice(0, length).trimEnd() + '…';
});
hbs.registerHelper('stars', (rating: unknown) => {
  const r = Math.max(0, Math.min(5, Math.round(Number(rating) || 0)));
  return new Handlebars.SafeString(`<span style="color:#f59e0b;white-space:nowrap;">${'★'.repeat(r)}${'☆'.repeat(5 - r)}</span>`);
});
hbs.registerHelper('json_pretty', (v: unknown) =>
  new Handlebars.SafeString(`<pre>${JSON.stringify(v, null, 2)}</pre>`),
);
hbs.registerHelper('hasNonImageFields', (fields: Array<{ type: string }>) =>
  Array.isArray(fields) && fields.some((f) => f.type !== 'image'),
);
hbs.registerHelper('percent', (processed: number, total: number) =>
  total > 0 ? Math.min(100, Math.round((processed / total) * 100)) : 0,
);
hbs.registerHelper('parseJson', (json: string) => {
  try { return JSON.parse(json); } catch { return []; }
});
hbs.registerHelper('jsonParse', (json: string) => {
  try { return JSON.parse(json); } catch { return {}; }
});
hbs.registerHelper('jsonLength', (json: string) => {
  try { return JSON.parse(json).length; } catch { return 0; }
});
hbs.registerHelper('jsonNonEmpty', (json: string) => {
  try { return JSON.parse(json).length > 0; } catch { return false; }
});
hbs.registerHelper('sparkline_bars', (daily: Array<{ date: string; views: number }>) => {
  if (!Array.isArray(daily) || daily.length === 0) return new Handlebars.SafeString('');
  const days: Array<{ label: string; views: number }> = [];
  for (let i = 6; i >= 0; i--) {
    const d = new Date();
    d.setDate(d.getDate() - i);
    const iso = d.toISOString().slice(0, 10);
    const label = d.toLocaleDateString('en-GB', { weekday: 'short' });
    const found = daily.find((r) => r.date === iso);
    days.push({ label, views: found?.views ?? 0 });
  }
  const max = Math.max(...days.map((d) => d.views), 1);
  const bars = days.map(({ label, views }) => {
    const pct = Math.round((views / max) * 100);
    return `<div style="display:flex;flex-direction:column;align-items:center;gap:0.25rem;flex:1;">
      <span style="font-size:0.75rem;color:#9ca3af;">${views}</span>
      <div style="width:100%;height:48px;display:flex;align-items:flex-end;">
        <div style="width:100%;border-radius:0.25rem 0.25rem 0 0;background:#1f2937;height:${Math.max(pct, 2)}%;" title="${views} views"></div>
      </div>
      <span style="font-size:0.75rem;color:#9ca3af;">${label}</span>
    </div>`;
  }).join('');
  return new Handlebars.SafeString(`<div style="display:flex;align-items:flex-end;gap:0.25rem;width:100%;height:80px;">${bars}</div>`);
});

/** Formats integer pence with the store's currency symbol; short form (£1.2k)
 *  for the compact bar-chart labels, full (£1,234.50) otherwise. */
function formatMoney(pence: number, settings: Record<string, string> | undefined, short: boolean): string {
  const symbols: Record<string, string> = { GBP: '£', USD: '$', EUR: '€' };
  const code = settings?.store_currency ?? 'GBP';
  const sym = symbols[code] ?? `${code} `;
  const value = pence / 100;
  if (short) {
    if (value >= 1000) return `${sym}${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}k`;
    return `${sym}${value < 10 && value > 0 ? value.toFixed(2) : Math.round(value)}`;
  }
  return `${sym}${value.toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

/** A revenue bar chart from a [{ label, revenue, orders }] series. Mirrors the
 *  sparkline_bars pattern but scales by money and labels each bar with its take. */
hbs.registerHelper('revenue_bars', function (points: Array<{ label: string; revenue: number; orders: number }>, options: Handlebars.HelperOptions) {
  if (!Array.isArray(points) || points.length === 0) {
    return new Handlebars.SafeString('<p class="text-sm text-muted">No sales in this period yet.</p>');
  }
  const settings = (options?.data?.root as Record<string, unknown>)?.settings as Record<string, string> | undefined;
  const esc = Handlebars.Utils.escapeExpression;
  const max = Math.max(...points.map((p) => p.revenue), 1);
  // Thin the x-axis labels so a dense (e.g. 30-bar) chart stays legible: show
  // roughly 8 of them, evenly spaced, always including the last.
  const step = Math.max(1, Math.ceil(points.length / 8));
  const bars = points.map((p, i) => {
    const pct = p.revenue > 0 ? Math.max(4, Math.round((p.revenue / max) * 100)) : 0;
    const tip = `${esc(p.label)}: ${formatMoney(p.revenue, settings, false)} · ${p.orders} order${p.orders === 1 ? '' : 's'}`;
    const cap = p.revenue > 0 ? formatMoney(p.revenue, settings, true) : '';
    const label = i % step === 0 || i === points.length - 1 ? esc(p.label) : '';
    return `<div class="rev-bar" title="${tip}">
      <span class="rev-bar__val">${esc(cap)}</span>
      <div class="rev-bar__track"><div class="rev-bar__fill" style="height:${pct}%"></div></div>
      <span class="rev-bar__label">${label}</span>
    </div>`;
  }).join('');
  return new Handlebars.SafeString(`<div class="rev-chart">${bars}</div>`);
});

/** A coloured period-over-period delta pill. null (no prior baseline) renders a
 *  neutral dash rather than a misleading 0%. */
hbs.registerHelper('delta_badge', (pct: number | null | undefined) => {
  if (pct == null) return new Handlebars.SafeString('<span class="delta delta--flat">— no prior data</span>');
  const cls = pct > 0 ? 'delta--up' : pct < 0 ? 'delta--down' : 'delta--flat';
  const arrow = pct > 0 ? '▲' : pct < 0 ? '▼' : '•';
  return new Handlebars.SafeString(`<span class="delta ${cls}">${arrow} ${Math.abs(pct)}%</span>`);
});

hbs.registerHelper('status_badge', (status: string) => {
  const colour: Record<string, string> = {
    pending: 'badge-yellow',
    paid: 'badge-green',
    refunded: 'badge-red',
    cancelled: 'badge-gray',
  };
  const cls = colour[status] ?? 'badge-gray';
  return new Handlebars.SafeString(
    `<span class="badge ${cls}">${Handlebars.Utils.escapeExpression(status)}</span>`,
  );
});

/**
 * Renders an admin page inside the shared layout.
 *
 * `reply` is required (not optional) so a CSRF token is generated and merged
 * into every context automatically — forgetting it is a compile error rather
 * than a template silently missing {{csrf_field}}. The one exception is the
 * pre-login auth templates (login/setup), which render standalone and have
 * their own session-less forms; call renderAuth() for those instead.
 */
export async function render(template: string, context: Record<string, unknown>, reply: FastifyReply): Promise<string> {
  const csrfToken = await reply.generateCsrf();
  // The cached status (never blocks) powers the "update available" banner in the
  // layout. A page may pass its own freshly-computed `update` (e.g. the Server
  // settings tab, which shouldn't sit on "Checking…" if the cache is cold);
  // only fall back to the cache when it hasn't.
  // cloudMode is injected globally so any template can hide what the control
  // plane manages, without every handler having to remember to pass it.
  const fullContext = {
    ...context,
    csrfToken,
    cloudMode: config.cloudMode,
    featureRequestUrl: FEATURE_REQUEST_URL,
    update: context.update ?? getCachedUpdateStatus(),
  };

  const file = path.join(ADMIN_VIEWS, `${template}.hbs`);
  const src = fs.readFileSync(file, 'utf-8');
  const body = hbs.compile(src)(fullContext);

  const layoutSrc = fs.readFileSync(path.join(ADMIN_VIEWS, 'partials', 'layout.hbs'), 'utf-8');
  return hbs.compile(layoutSrc)({ ...fullContext, body: new Handlebars.SafeString(body) });
}

/** Renders a template with no session yet (login/setup) — still gets a CSRF token, just no layout. */
export async function renderAuth(template: string, context: Record<string, unknown>, reply: FastifyReply): Promise<string> {
  const csrfToken = await reply.generateCsrf();
  const file = path.join(ADMIN_VIEWS, `${template}.hbs`);
  const src = fs.readFileSync(file, 'utf-8');
  return hbs.compile(src)({ ...context, csrfToken, cloudMode: config.cloudMode });
}

/** Renders a template without the admin layout — for htmx fragment responses (polling, inline swaps). */
export function renderFragment(template: string, context: Record<string, unknown>): string {
  const file = path.join(ADMIN_VIEWS, `${template}.hbs`);
  const src = fs.readFileSync(file, 'utf-8');
  return hbs.compile(src)(context);
}

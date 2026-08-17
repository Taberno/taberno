import { describe, it, expect } from 'vitest';
import { render } from '../../src/admin/render';

/** The admin layout footer carries a "Request a feature" link that deep-links to
 *  GitHub's new-issue form, pre-filled — no API token to manage per store. */
describe('feature-request link', () => {
  const reply = { generateCsrf: async () => 'tok' } as never;

  async function layoutHtml(): Promise<string> {
    // Any template renders inside the shared layout; 404 needs the least context.
    return render('404', { admin: { name: 'Jane', role: 'admin' }, settings: {} }, reply);
  }

  it('appears in the sidebar footer, opening the repo issue form in a new tab', async () => {
    const html = await layoutHtml();
    expect(html).toContain('Request a feature');
    const m = html.match(/href="([^"]*issues\/new[^"]*)"[^>]*target="_blank"[^>]*rel="noopener"/);
    expect(m).not.toBeNull();
    expect(m![1]).toContain('github.com/taberno/taberno/issues/new');
  });

  it('pre-fills the enhancement label, a title and a body once entities decode', async () => {
    const html = await layoutHtml();
    const raw = html.match(/href="([^"]*issues\/new[^"]*)"/)![1];
    // Browsers decode HTML entities in the attribute before navigating.
    const url = new URL(raw.replace(/&#x3D;/g, '=').replace(/&amp;/g, '&'));
    expect(url.searchParams.get('labels')).toBe('enhancement');
    expect(url.searchParams.get('title')).toBe('Feature request: ');
    expect(url.searchParams.get('body')).toContain('What would you like to add or change?');
  });
});

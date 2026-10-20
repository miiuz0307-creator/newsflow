/**
 * Short-lived cache in front of a RouteSource. A busy source group can post
 * many messages a minute; without a cache each message costs three database
 * queries just to find its routes.
 *
 * Changes made through the API take effect within `ttlMs` (default 5 s), or
 * immediately when the API calls invalidate().
 */
import type { ChatRef } from '../core/types.js';
import { chatKey } from '../core/types.js';
import type { Route, Template } from '../routing/types.js';
import type { RouteSource } from './pipeline.js';

export class CachedRouteSource implements RouteSource {
  private routes = new Map<string, { at: number; v: Promise<Route[]> }>();
  private templates = new Map<string, { at: number; v: Promise<Template | undefined> }>();

  constructor(private readonly inner: RouteSource, private readonly ttlMs = 5_000, private readonly now: () => number = Date.now) {}

  routesForSource(chat: ChatRef): Promise<Route[]> {
    const k = chatKey(chat);
    const hit = this.routes.get(k);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.v;
    const v = this.inner.routesForSource(chat);
    this.routes.set(k, { at: this.now(), v });
    v.catch(() => this.routes.delete(k)); // never cache a failure
    return v;
  }

  template(tenantId: string, id: string): Promise<Template | undefined> {
    const k = `${tenantId}|${id}`;
    const hit = this.templates.get(k);
    if (hit && this.now() - hit.at < this.ttlMs) return hit.v;
    const v = this.inner.template(tenantId, id);
    this.templates.set(k, { at: this.now(), v });
    v.catch(() => this.templates.delete(k));
    return v;
  }

  /** Drop everything (call after a route or template is saved, enabled or disabled). */
  invalidate(): void {
    this.routes.clear();
    this.templates.clear();
  }
}

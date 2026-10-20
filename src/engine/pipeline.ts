/**
 * Inbound pipeline: a message arrives in a group → find the routes that use
 * that group as a source → plan the sends → store media once → enqueue.
 *
 * Kept separate from the dispatcher so that receiving and sending can scale
 * independently (and a sending backlog never delays receiving).
 */
import type { ChatRef, InboundMessage } from '../core/types.js';
import type { MediaStore } from '../delivery/mediaStore.js';
import type { JobQueue } from '../delivery/queue.js';
import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';
import type { Router } from '../routing/router.js';
import type { Route, RoutingPlan, Template } from '../routing/types.js';

export interface RouteSource {
  /** Enabled and disabled routes that list `chat` as a source. */
  routesForSource(chat: ChatRef): Promise<Route[]>;
  template(tenantId: string, id: string): Promise<Template | undefined>;
}

export class MemoryRouteSource implements RouteSource {
  readonly routes = new Map<string, Route>();
  readonly templates = new Map<string, Template>();
  upsertRoute(r: Route) {
    this.routes.set(r.id, r);
  }
  upsertTemplate(t: Template) {
    this.templates.set(t.id, t);
  }
  async routesForSource(chat: ChatRef) {
    return [...this.routes.values()].filter((r) =>
      r.sources.some((s) => s.platform === chat.platform && s.accountId === chat.accountId && s.chatId === chat.chatId),
    );
  }
  async template(tenantId: string, id: string) {
    const t = this.templates.get(id);
    return t && t.tenantId === tenantId ? t : undefined;
  }
}

export interface PipelineOptions {
  routes: RouteSource;
  router: Router;
  queue: JobQueue;
  media?: MediaStore;
  logger?: Logger;
  /** Largest media we accept for forwarding, in bytes. */
  maxMediaBytes?: number;
  onPlanned?: (msg: InboundMessage, plan: RoutingPlan, inserted: number) => void;
}

export class InboundPipeline {
  private readonly log: Logger;
  constructor(private readonly o: PipelineOptions) {
    this.log = (o.logger ?? silentLogger).child({ component: 'pipeline' });
  }

  async handle(msg: InboundMessage): Promise<{ planned: number; inserted: number; skipped: RoutingPlan['skipped'] }> {
    const routes = await this.o.routes.routesForSource(msg.source);
    if (!routes.length) return { planned: 0, inserted: 0, skipped: [] };
    const plan = await this.o.router.plan(msg, routes);
    if (plan.jobs.length && msg.content.media) {
      await this.storeMediaOnce(msg, plan);
    }
    const { inserted } = plan.jobs.length ? await this.o.queue.enqueue(plan.jobs) : { inserted: 0 };
    this.log.info('planned', { tenantId: msg.tenantId, messageId: msg.messageId, jobs: plan.jobs.length, inserted, skipped: plan.skipped.length });
    this.o.onPlanned?.(msg, plan, inserted);
    return { planned: plan.jobs.length, inserted, skipped: plan.skipped };
  }

  /** Downloads (if needed) and stores the media once; every job then carries only the reference. */
  private async storeMediaOnce(msg: InboundMessage, plan: RoutingPlan) {
    const media = msg.content.media!;
    if (!this.o.media) throw new Error('media message received but no media store configured');
    const data = media.data ?? (media.load ? await media.load() : undefined);
    if (!data) throw new Error('media has no bytes');
    const max = this.o.maxMediaBytes ?? 64 * 1024 * 1024;
    if (data.length > max) throw new Error(`media too large (${data.length} bytes)`);
    const ref = await this.o.media.put(msg.tenantId, data, media.mimeType);
    for (const j of plan.jobs) {
      const { data: _d, load: _l, ...rest } = j.content.media ?? media;
      j.content = { ...j.content, media: { ...rest, size: data.length, ref } };
    }
  }
}

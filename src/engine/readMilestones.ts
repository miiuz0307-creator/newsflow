/**
 * "🎉 100 people read this message."
 *
 * Every read receipt of a copy counts once (see JobQueue.recordRead). After a new read, the
 * copies of the same source message are added up; when the total reaches one of the read
 * milestones the customer set for that control group, a short note goes to the control group
 * (and, through `notify`, to the customer's phone). Each milestone is announced once per
 * message; if several are passed at once, only the highest is announced.
 *
 * Reads are what WhatsApp reports: people who turned read receipts off are not counted.
 */
import type { JobQueue, StoredJob } from '../delivery/queue.js';
import type { Logger } from '../logger.js';
import { silentLogger } from '../logger.js';
import type { RouteSource } from './pipeline.js';
import type { Reporter } from './reporter.js';

export interface MilestoneNotice { tenantId: string; threshold: number; snippet: string; job: StoredJob }

/** The first words of the message, for the note ("„פיגוע בצפון…“"). */
export function snippetOf(text: string | undefined, max = 60): string {
  const t = (text ?? '').replace(/\s+/g, ' ').replace(/[*_~`]/g, '').trim();
  return t.length > max ? `${t.slice(0, max).trim()}…` : t;
}

export class ReadMilestones {
  private readonly log: Logger;
  constructor(private readonly o: {
    queue: JobQueue;
    routes: RouteSource;
    reporter: Pick<Reporter, 'onReadMilestone'>;
    notify?: (n: MilestoneNotice) => Promise<void> | void;
    logger?: Logger;
  }) {
    this.log = (o.logger ?? silentLogger).child({ component: 'read-milestones' });
  }

  /** Call after a read was counted (recordRead returned true). */
  async onRead(platform: string, chatId: string, messageId: string): Promise<void> {
    const q = this.o.queue;
    if (!q.readTotal || !q.claimMilestone) return;
    const r = await q.readTotal(platform, chatId, messageId);
    if (!r || r.total < 1) return;
    const { job, total } = r;
    const route = (await this.o.routes.routesForSource(job.source)).find((x) => x.id === job.routeId && x.tenantId === job.tenantId && x.control);
    const steps = route?.control?.readMilestones;
    if (!route || !steps?.length) return;
    const passed = steps.filter((t) => t <= total).sort((a, b) => b - a);
    let announced = false;
    for (const t of passed) {
      // Claimed highest first: when a jump passes several milestones, only the highest is announced.
      if (!(await q.claimMilestone(job.tenantId, job.source, job.sourceMessageId, t))) break;
      if (announced) continue;
      announced = true;
      const snippet = snippetOf(job.content.kind === 'text' || job.content.text ? job.content.text : undefined);
      await this.o.reporter.onReadMilestone(route, job.source, job.sourceMessageId, t, snippet);
      try {
        await this.o.notify?.({ tenantId: job.tenantId, threshold: t, snippet, job });
      } catch (err) {
        this.log.info('milestone notice not sent', { err: String(err).slice(0, 200) });
      }
      this.log.info('read milestone', { tenantId: job.tenantId, threshold: t });
    }
  }
}

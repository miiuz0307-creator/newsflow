import type { ChatRef, MessageContent, MessageKind } from '../core/types.js';

export interface RouteTarget extends ChatRef {
  /** Display name, used by the {group_name} placeholder. */
  title?: string;
}

export interface RouteFilters {
  /** Allowed message kinds. Empty or missing = all supported kinds. */
  kinds?: MessageKind[];
  /** At least one of these must appear (after normalization). */
  includeAny?: string[];
  /** None of these may appear. */
  excludeAny?: string[];
  /** Skip messages the connected account sent itself. Default true — this is the loop guard. */
  ignoreFromSelf?: boolean;
  /** Skip messages marked "forwarded". Default false. */
  ignoreForwarded?: boolean;
  /** Remove WhatsApp / Telegram invite links from the forwarded text. Default true. */
  removeInviteLinks?: boolean;
  /** Ignore very short texts (e.g. "👍"). Applies to text messages only. */
  minTextLength?: number;
}

export interface QuietHours {
  /** "HH:MM" local time. A window may cross midnight (23:00 → 06:00). */
  start: string;
  end: string;
  timeZone: string;
}

export type ReportMode = 'all' | 'failures' | 'summary' | 'off';

/**
 * Settings that make a route's source a PUSH control group: the customer
 * posts there, and edits and deletes there follow every copy.
 */
export interface ControlSettings {
  /** An edit in the control group edits every copy. Default true. */
  syncEdits?: boolean;
  /** "Delete for everyone" in the control group deletes every copy. Default true. */
  syncDeletes?: boolean;
  /** Status messages posted back into the control group. Default 'summary'. */
  reportMode?: ReportMode;
  /**
   * Only these senders (phone numbers / Telegram user ids) may distribute.
   * Empty or missing = anyone in the control group.
   */
  allowedSenders?: string[];
  /**
   * Fixed text added under every message (a link, a line about the channel…).
   * Placeholders such as {תאריך} work here too.
   */
  signature?: string;
}

export interface Route {
  id: string;
  tenantId: string;
  name: string;
  enabled: boolean;
  sources: ChatRef[];
  targets: RouteTarget[];
  filters: RouteFilters;
  templateId?: string;
  /** Hold every message for the customer's approval before it is sent. */
  requireApproval: boolean;
  /** Fixed delay before sending, in seconds (e.g. to let the editor fix typos). */
  delaySeconds?: number;
  quietHours?: QuietHours;
  /** Present when the source is a PUSH control group. */
  control?: ControlSettings;
}

export interface Template {
  id: string;
  tenantId: string;
  name: string;
  /** Text with placeholders such as {content} / {תוכן החדשות}, {group_name}, {whatsapp_link}. */
  body: string;
  /** Customer-defined values: {whatsapp_link: 'https://chat.whatsapp.com/...'} */
  vars: Record<string, string>;
}

export type SkipReason =
  | 'route_disabled'
  | 'not_a_source'
  | 'from_self'
  | 'forwarded'
  | 'kind_not_allowed'
  | 'missing_keyword'
  | 'excluded_keyword'
  | 'too_short'
  | 'empty_after_cleanup'
  | 'duplicate'
  | 'own_forward'
  | 'sender_not_allowed'
  | 'own_report';

/** send = a copy; edit / delete change a copy already sent; report = a status message to the control group. */
export type JobAction = 'send' | 'edit' | 'delete' | 'report';

/** Lower runs first. A delete beats everything; reports wait for the real work. */
export const ACTION_PRIORITY: Record<JobAction, number> = { delete: 0, edit: 1, send: 2, report: 3 };

export interface PlannedJob {
  tenantId: string;
  routeId: string;
  source: ChatRef;
  sourceMessageId: string;
  target: RouteTarget;
  content: MessageContent;
  /** Earliest send time. */
  notBefore: Date;
  requiresApproval: boolean;
  /** Unique per (inbound message, route, target): creating the same job twice is a no-op. */
  idempotencyKey: string;
  /** Default 'send'. */
  action?: JobAction;
  /** For edit / delete: the send job whose copy is changed. */
  parentJobId?: string;
  /** Version of the source message this job carries (1 = the original). */
  version?: number;
}

export interface RoutingPlan {
  jobs: PlannedJob[];
  /** Duplicate-detection keys claimed for these jobs; released if the jobs can't be stored. */
  claimedKeys?: { tenantId: string; key: string }[];
  skipped: { routeId: string; reason: SkipReason; target?: string }[];
}

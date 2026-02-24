import { z } from 'zod';

const TimestampSchema = z.string().datetime({ offset: true });

export const BotIdSchema = z.enum(['copy', 'mm', 'sniper']);
export type BotId = z.infer<typeof BotIdSchema>;

export const BotModeSchema = z.enum(['dry', 'live']);
export type BotMode = z.infer<typeof BotModeSchema>;

export const BotStateSchema = z.enum(['idle', 'starting', 'running', 'stopping', 'error']);
export type BotState = z.infer<typeof BotStateSchema>;

export const BotStatusSchema = z.object({
  bot: BotIdSchema,
  mode: BotModeSchema,
  state: BotStateSchema,
  updatedAt: TimestampSchema,
  lastError: z.string().nullable().optional(),
});
export type BotStatus = z.infer<typeof BotStatusSchema>;

export const ConnectionConfigSchema = z.object({
  proxyWallet: z.string(),
  polygonRpcUrl: z.string().url(),
});
export type ConnectionConfig = z.infer<typeof ConnectionConfigSchema>;

export const CopyTradeConfigSchema = z.object({
  traderAddress: z.string(),
  sizeMode: z.enum(['percentage', 'balance']),
  sizePercent: z.number().positive(),
  minTradeSize: z.number().nonnegative(),
  maxPositionSize: z.number().positive(),
  autoSellEnabled: z.boolean(),
  autoSellProfitPercent: z.number().nonnegative(),
  sellMode: z.enum(['market', 'limit']),
  redeemIntervalSeconds: z.number().int().positive(),
  dryRun: z.boolean(),
});
export type CopyTradeConfig = z.infer<typeof CopyTradeConfigSchema>;

export const MarketMakerConfigSchema = z.object({
  assets: z.array(z.string().min(1)).min(1),
  duration: z.enum(['5m', '15m']),
  tradeSize: z.number().positive(),
  sellPrice: z.number().gt(0).lt(1),
  cutLossTimeSeconds: z.number().int().positive(),
  marketKeyword: z.string().min(1),
  entryWindowSeconds: z.number().int().nonnegative(),
  pollIntervalSeconds: z.number().int().positive(),
  recoveryBuyEnabled: z.boolean(),
  recoveryThreshold: z.number().gt(0).lt(1),
  recoverySize: z.number().nonnegative(),
  dryRun: z.boolean(),
});
export type MarketMakerConfig = z.infer<typeof MarketMakerConfigSchema>;

export const SniperConfigSchema = z.object({
  assets: z.array(z.string().min(1)).min(1),
  price: z.number().gt(0).lt(1),
  shares: z.number().positive(),
  dryRun: z.boolean(),
});
export type SniperConfig = z.infer<typeof SniperConfigSchema>;

export const SecretPresenceSchema = z.object({
  hasPrivateKey: z.boolean(),
  hasClobApiKey: z.boolean(),
  hasClobApiSecret: z.boolean(),
  hasClobApiPassphrase: z.boolean(),
});
export type SecretPresence = z.infer<typeof SecretPresenceSchema>;

export const RiskConfigSchema = z.object({
  maxOrderSizeUsd: z.number().positive(),
  maxExposureUsd: z.number().positive(),
  killSwitchArmed: z.boolean(),
  alertOnError: z.boolean(),
});
export type RiskConfig = z.infer<typeof RiskConfigSchema>;

export const RuntimeConfigSchema = z.object({
  connection: ConnectionConfigSchema,
  copy: CopyTradeConfigSchema,
  mm: MarketMakerConfigSchema,
  sniper: SniperConfigSchema,
  risk: RiskConfigSchema,
  secrets: SecretPresenceSchema,
});
export type RuntimeConfig = z.infer<typeof RuntimeConfigSchema>;

export const SecretsWriteSchema = z.object({
  privateKey: z.string().min(1).optional(),
  clobApiKey: z.string().min(1).optional(),
  clobApiSecret: z.string().min(1).optional(),
  clobApiPassphrase: z.string().min(1).optional(),
});

export const ConfigPatchSchema = z.object({
  connection: ConnectionConfigSchema.partial().optional(),
  copy: CopyTradeConfigSchema.partial().optional(),
  mm: MarketMakerConfigSchema.partial().optional(),
  sniper: SniperConfigSchema.partial().optional(),
  risk: RiskConfigSchema.partial().optional(),
  secrets: SecretsWriteSchema.optional(),
});
export type ConfigPatch = z.infer<typeof ConfigPatchSchema>;

export const AuditActionSchema = z.enum([
  'config_updated',
  'bot_start',
  'bot_stop',
  'bot_restart',
  'kill_switch',
  'kill_switch_reset',
]);
export type AuditAction = z.infer<typeof AuditActionSchema>;

export const AuditEventSchema = z.object({
  id: z.string().min(1),
  timestamp: TimestampSchema,
  action: AuditActionSchema,
  source: z.string().min(1),
  bot: BotIdSchema.optional(),
  metadata: z.record(z.unknown()).optional(),
});
export type AuditEvent = z.infer<typeof AuditEventSchema>;

const SideSchema = z.enum(['buy', 'sell']);
const OrderStatusSchema = z.enum(['open', 'filled', 'partially_filled', 'cancelled', 'failed']);

export const PositionSchema = z.object({
  conditionId: z.string().min(1),
  tokenId: z.string().min(1),
  side: SideSchema,
  shares: z.number().nonnegative(),
  avgBuyPrice: z.number().nonnegative().lte(1),
  market: z.string().min(1),
  unrealizedPnl: z.number(),
  realizedPnl: z.number(),
  updatedAt: TimestampSchema,
});
export type Position = z.infer<typeof PositionSchema>;

export const OrderSchema = z.object({
  id: z.string().min(1),
  bot: BotIdSchema,
  conditionId: z.string().min(1),
  tokenId: z.string().min(1),
  side: SideSchema,
  price: z.number().gt(0).lt(1),
  size: z.number().positive(),
  status: OrderStatusSchema,
  createdAt: TimestampSchema,
  updatedAt: TimestampSchema,
});
export type Order = z.infer<typeof OrderSchema>;

export const TradeSchema = z.object({
  id: z.string().min(1),
  bot: BotIdSchema,
  orderId: z.string().min(1).optional(),
  conditionId: z.string().min(1),
  tokenId: z.string().min(1),
  side: SideSchema,
  price: z.number().gt(0).lt(1),
  size: z.number().positive(),
  fee: z.number().nonnegative(),
  timestamp: TimestampSchema,
});
export type Trade = z.infer<typeof TradeSchema>;

export const LogLevelSchema = z.enum(['debug', 'info', 'warn', 'error', 'success']);
export type LogLevel = z.infer<typeof LogLevelSchema>;

export const LogEntrySchema = z.object({
  id: z.string().min(1),
  bot: BotIdSchema.optional(),
  level: LogLevelSchema,
  message: z.string().min(1),
  timestamp: TimestampSchema,
  context: z.record(z.unknown()).optional(),
});
export type LogEntry = z.infer<typeof LogEntrySchema>;

export const AlertSeveritySchema = z.enum(['info', 'warning', 'critical']);
export type AlertSeverity = z.infer<typeof AlertSeveritySchema>;

export const AlertSchema = z.object({
  id: z.string().min(1),
  severity: AlertSeveritySchema,
  code: z.string().min(1),
  message: z.string().min(1),
  bot: BotIdSchema.optional(),
  timestamp: TimestampSchema,
  acknowledged: z.boolean(),
});
export type Alert = z.infer<typeof AlertSchema>;

export const BotStateEventSchema = z.object({
  topic: z.literal('bot_state'),
  ts: TimestampSchema,
  payload: BotStatusSchema,
});

export const OrderEventSchema = z.object({
  topic: z.literal('order'),
  ts: TimestampSchema,
  payload: OrderSchema,
});

export const TradeEventSchema = z.object({
  topic: z.literal('trade'),
  ts: TimestampSchema,
  payload: TradeSchema,
});

export const PositionEventSchema = z.object({
  topic: z.literal('position'),
  ts: TimestampSchema,
  payload: PositionSchema,
});

export const LogEventSchema = z.object({
  topic: z.literal('log'),
  ts: TimestampSchema,
  payload: LogEntrySchema,
});

export const AlertEventSchema = z.object({
  topic: z.literal('alert'),
  ts: TimestampSchema,
  payload: AlertSchema,
});

export const StreamEventSchema = z.discriminatedUnion('topic', [
  BotStateEventSchema,
  OrderEventSchema,
  TradeEventSchema,
  PositionEventSchema,
  LogEventSchema,
  AlertEventSchema,
]);
export type StreamEvent = z.infer<typeof StreamEventSchema>;

export const HealthResponseSchema = z.object({
  status: z.enum(['ok', 'degraded']),
  timestamp: TimestampSchema,
  uptimeSeconds: z.number().nonnegative(),
  bots: z.array(BotStatusSchema),
});
export type HealthResponse = z.infer<typeof HealthResponseSchema>;

export const ApiErrorSchema = z.object({
  code: z.string().min(1),
  message: z.string().min(1),
  details: z.record(z.unknown()).optional(),
});
export type ApiError = z.infer<typeof ApiErrorSchema>;

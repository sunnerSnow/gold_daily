import type { TargetLine } from '../line/messages';
import type { InstrumentKey, PriceTargetRow } from '../store/types';
import type { JobDeps } from './deps';

// 到價提醒的判斷與關閉（不負責發送；發送在 targets.ts 與每日推播）。
// 價格漲到目標價以上（above）或跌到以下（below）時通知一次，然後自動關閉（要再提醒就到後台重新啟用）。
// 只比較同一個來源、商品、幣別、單位的價格。關閉用資料庫的原子更新，同一個目標價不會通知兩次。
// 同一個方向有好幾個目標價都達到時，只列最接近目前價格的那一個，其他的註明「同時達到」並一起關閉
// （例如設了跌到 3900、4000 以下，價格 3894 → 列 3900，4000 一起關閉）。

export function isTargetHit(t: Pick<PriceTargetRow, 'direction' | 'targetPrice'>, price: number): boolean {
  return t.direction === 'above' ? price >= t.targetPrice : price <= t.targetPrice;
}

const sameInstrument = (a: InstrumentKey, b: InstrumentKey) =>
  a.source === b.source && a.symbol === b.symbol && a.currency === b.currency && a.unit === b.unit;

/** 已達到的目標價中，越接近目前價格的排越前面（漲到以上：目標價高的優先；跌到以下：目標價低的優先） */
const closestFirst = (a: PriceTargetRow, b: PriceTargetRow) =>
  a.direction === 'above' ? b.targetPrice - a.targetPrice : a.targetPrice - b.targetPrice;

/** 一個方向的到價結果：通知的那一個（最接近目前價格），以及同時達到、跟著關閉的其他目標價 */
export interface TargetHit {
  target: PriceTargetRow;
  merged: PriceTargetRow[];
}

/** 把已達到的目標價依方向分組，每組最接近目前價格的排第一個 */
export function groupTargetHits(rows: PriceTargetRow[]): TargetHit[] {
  const hits: TargetHit[] = [];
  for (const direction of ['above', 'below'] as const) {
    const [target, ...merged] = rows.filter((r) => r.direction === direction).sort(closestFirst);
    if (target) hits.push({ target, merged });
  }
  return hits;
}

/** 給每日訊息用的到價段落資料 */
export function toTargetLines(hits: TargetHit[]): TargetLine[] {
  return hits.map(({ target, merged }) => ({
    direction: target.direction,
    targetPrice: target.targetPrice,
    alsoReached: merged.map((t) => t.targetPrice),
    note: target.note,
  }));
}

/** 排程紀錄用：「≤ 3900」，有一起關閉的再加上「，一併關閉 4000」 */
export function describeTargetHit(o: TargetHit): string {
  const head = `${o.target.direction === 'above' ? '≥' : '≤'} ${o.target.targetPrice}`;
  return o.merged.length > 0 ? `${head}，一併關閉 ${o.merged.map((t) => t.targetPrice).join('、')}` : head;
}

/** 這個價格達到哪些啟用中的目標價（只判斷，不改資料） */
export async function findTargetHits(deps: JobDeps, price: number, instrument: InstrumentKey): Promise<TargetHit[]> {
  // 啟用中的目標價最多 10 個（actions.ts 的 MAX_ACTIVE_TARGETS），50 筆一定讀得完
  const active = await deps.store.listPriceTargets({ statuses: ['active'], limit: 50 });
  return groupTargetHits(active.filter((t) => sameInstrument(t, instrument) && isTargetHit(t, price)));
}

export interface TriggerFields {
  triggeredAt: Date;
  triggeredPrice: number;
  triggeredQuoteAt: Date;
  /** 已經有通知它的事件時（併入每日推播）一起寫入，關閉與指向事件不會中途斷掉 */
  eventId?: number;
}

/** 關閉達到的目標價（原子操作）；已經被別的排程觸發或被取消的會略過。回傳實際關閉的部分（重新分組） */
export async function triggerTargetHits(deps: JobDeps, hits: TargetHit[], fields: TriggerFields): Promise<TargetHit[]> {
  const closed: PriceTargetRow[] = [];
  for (const t of hits.flatMap((h) => [h.target, ...h.merged])) {
    const row = await deps.store.triggerPriceTarget(t.id, fields);
    if (row) closed.push(row);
  }
  return groupTargetHits(closed);
}

/** 讓關閉的目標價指向事後才建立的通知事件（單獨推送時用；設定頁的「最近觸發」會顯示那則事件的發送狀態） */
export async function linkTargetHits(deps: JobDeps, hits: TargetHit[], eventId: number): Promise<void> {
  for (const t of hits.flatMap((h) => [h.target, ...h.merged])) await deps.store.updatePriceTarget(t.id, { eventId });
}

/** 每日推播事件的到價段落（補送、重試時從資料庫重建，跟當初送出的一樣） */
export async function targetLinesForEvent(deps: JobDeps, eventId: number): Promise<TargetLine[]> {
  const rows = (await deps.store.listPriceTargets({ statuses: ['triggered'], limit: 200 })).filter((t) => t.eventId === eventId);
  return toTargetLines(groupTargetHits(rows));
}

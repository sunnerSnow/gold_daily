import type { Metadata } from 'next';
import { removeTelegramSubscriberAction, setMockScenarioAction, setupTelegramWebhookAction, telegramTestPushAction, testPushAction } from '@/app/actions';
import { ActionButton } from '@/components/action-button';
import { PriceTargetsCard, type TargetView } from '@/components/price-targets-card';
import { SettingsForm, type BaselineInfo } from '@/components/settings-form';
import { PageHead } from '@/components/site-chrome';
import { EventStatusChip } from '@/components/status-chips';
import { MockScenarioForm } from '@/components/mock-scenario-form';
import { chartPath } from '@/lib/chart/daily-chart';
import { checkEnv, getEnv, parseLineUserIds, parseTelegramChatIds } from '@/lib/env';
import { formatPrice } from '@/lib/gold/math';
import { PROVIDER_SAFETY_MARGIN } from '@/lib/gold/budget';
import { MOCK_SCENARIOS } from '@/lib/gold/mock-provider';
import { latestDailyPreview } from '@/lib/jobs/chart-data';
import { describeEvent } from '@/lib/jobs/daily';
import { MAX_TELEGRAM_SUBSCRIBERS } from '@/lib/jobs/notify';
import { hasIntradayChecks } from '@/lib/schedule';
import { UNIT_LABEL } from '@/lib/gold/types';
import { getPageDeps } from '@/lib/server';
import { chatLabel } from '@/lib/telegram/client';
import { formatTaipei, taipeiDate } from '@/lib/time';
import { loadDashboard } from '@/lib/view/dashboard';

export const metadata: Metadata = { title: '推播設定' };
export const dynamic = 'force-dynamic';

const BASIS_SOURCE = { first_valid_of_day: '當日首筆有效報價', previous_close: '前一交易日每日快照', manual: '手動輸入' } as const;

export default async function SettingsPage() {
  const deps = await getPageDeps();
  const env = getEnv();
  const envStatus = checkEnv(env);
  const data = await loadDashboard(deps);
  const s = data.settings;
  const today = taipeiDate(data.now);
  const unit = data.provider.instrument ? `${data.provider.instrument.currency} / ${UNIT_LABEL[data.provider.instrument.unit]}` : '';

  const baselineValid = s.baselinePrice !== null && (s.baselineMode === 'manual' || s.baselineDate === today);
  const baseline: BaselineInfo | null = baselineValid
    ? {
        price: formatPrice(s.baselinePrice),
        unit,
        createdAt: formatTaipei(s.baselineTimestamp),
        source: s.baselineMode === 'first_valid_of_day' && !hasIntradayChecks(s) ? '前一交易日每日快照（只在每日推播時查價）' : BASIS_SOURCE[s.baselineMode],
        nextReset: s.baselineMode === 'manual' ? '不會自動重設' : '下一個台北日期的第一筆有效報價',
      }
    : null;

  // 每日推播預覽：用最新一筆每日快照與它的前一交易日（跟測試推播同一份）
  const preview = await latestDailyPreview(deps);
  const latestDaily = preview?.snapshot ?? null;
  const dailyPreview = preview?.text ?? null;
  const alertEvent = (await deps.store.listEvents({ types: ['alert_up', 'alert_down'], limit: 20 })).find((e) => e.messageText);
  const lastTest = (await deps.store.listEvents({ types: ['test'], limit: 1 }))[0] ?? null;
  // 只顯示每個 User ID 的末 4 碼
  const recipientTails = envStatus.line ? parseLineUserIds(env.LINE_USER_ID).map((id) => id.slice(-4)) : [];
  // Telegram：固定收件人（頻道 @username 原樣顯示，數字 ID 只顯示末 4 碼）＋訂閱者；測試推播只送固定收件人
  const telegramChats = envStatus.telegram ? parseTelegramChatIds(env.TELEGRAM_CHAT_ID) : [];
  const [botUsername, webhookInfo, activeSubscribers, recentSubscribers] = envStatus.telegram
    ? await Promise.all([
        deps.telegram.getUsername(),
        deps.telegram.getWebhookInfo(),
        deps.store.listTelegramSubscribers({ statuses: ['active'], limit: MAX_TELEGRAM_SUBSCRIBERS }),
        deps.store.listTelegramSubscribers({ limit: 50 }),
      ])
    : [null, null, [], []];
  const webhookUrl = deps.appUrl?.startsWith('https://') ? `${deps.appUrl}/api/telegram/webhook` : null;
  const subscriptionOpen = Boolean(webhookUrl && webhookInfo?.url === webhookUrl);
  const subscribeLink = botUsername ? `https://t.me/${botUsername}` : null;
  const telegramNote = !envStatus.telegram
    ? ''
    : telegramChats.length
      ? `Telegram 只送固定收件人（${telegramChats.length} 個聊天室），不會送給訂閱者。`
      : 'Telegram 沒有固定收件人（TELEGRAM_CHAT_ID），這次不會測試 Telegram。';
  const lineAudience = `會送給${envStatus.lineTarget === 'all' ? '所有好友（約 ' : ''}${data.recipients} 人${envStatus.lineTarget === 'all' ? '）' : ''}`;
  const testHint =
    !envStatus.line && envStatus.telegram
      ? `LINE 尚未連線。${telegramNote}`
      : `${lineAudience}，用掉 ${data.recipients} 則訊息額度${data.quota.remaining !== null ? `（保守估算剩餘 ${data.quota.remaining} 則）` : ''}。${telegramNote}`;
  const testConfirm =
    !envStatus.line && envStatus.telegram
      ? `會送到 Telegram 的固定收件人（${telegramChats.length} 個聊天室），確定要發送嗎？`
      : `${lineAudience}，用掉 ${data.recipients} 則 LINE 訊息額度${telegramChats.length ? '，並同時送到 Telegram 的固定收件人' : ''}，確定要發送嗎？`;
  const SUBSCRIBER_STATUS = { active: ['chip--ok', '訂閱中'], stopped: ['chip--muted', '已取消'], blocked: ['chip--warn', '無法傳送'] } as const;

  const quota = data.provider.monthlyCallQuota;
  // 到價提醒平常併入每日推播（指向 daily 事件），每日推播停用時才是單獨的 target 事件
  const targetEvents = new Map(
    (await deps.store.listEvents({ types: ['target', 'daily'], limit: 80 })).map(
      (e) => [e.id, e.eventType === 'daily' ? `併入每日推播・${describeEvent(e)}` : describeEvent(e)] as const,
    ),
  );
  const toView = (t: (typeof data.targets)[number]): TargetView => ({
    id: t.id,
    direction: t.direction,
    targetPrice: t.targetPrice,
    note: t.note,
    status: t.status,
    createdAt: formatTaipei(t.createdAt, false).slice(5),
    triggeredAt: t.triggeredAt ? formatTaipei(t.triggeredAt, false).slice(5) : null,
    triggeredPrice: t.triggeredPrice,
    eventLabel: t.eventId ? targetEvents.get(t.eventId) ?? null : null,
  });
  const checkSummary = s.dailyEnabled
    ? `每天 ${s.dailyPushTime} 每日推播時用當天的價格判斷，達到的目標價寫在那則每日行情裡，不另外推。`
    : s.intradayMode === 'times'
      ? `每日推播已停用，改在盤中檢查（${s.checkTimes.join('、')}）判斷，達到時單獨推一則。`
      : s.intradayMode === 'interval'
        ? `每日推播已停用，改在盤中檢查（每 ${s.pollingIntervalMinutes} 分鐘）判斷，達到時單獨推一則。`
        : '每日推播與盤中檢查都已停用，目前不會判斷到價。';

  return (
    <>
      <div className="on-gold">
        <PageHead eyebrow="Settings" title="推播設定" description="變更在下一次排程生效・所有時間為台北時間" />
      </div>
      <main className="page">
        <div className="row">
          <div className="col-main">
          <SettingsForm
            initial={{
              dailyEnabled: s.dailyEnabled,
              dailyPushTime: s.dailyPushTime,
              alertEnabled: s.alertEnabled,
              riseThresholdPercent: s.riseThresholdPercent,
              fallThresholdPercent: s.fallThresholdPercent,
              intradayMode: s.intradayMode,
              checkTimes: s.checkTimes.join(', '),
              pollingIntervalMinutes: s.pollingIntervalMinutes,
              skipWeekends: s.skipWeekends,
              saturdayPush: s.saturdayPush,
              cooldownMinutes: s.cooldownMinutes,
              baselineMode: s.baselineMode,
              manualBaselinePrice: s.baselineMode === 'manual' && s.baselinePrice ? String(s.baselinePrice) : '',
              linePlan: s.linePlan,
              monthlyMessageQuota: s.monthlyMessageQuota,
              quotaSafetyBuffer: s.quotaSafetyBuffer,
            }}
            baseline={baseline}
            lastSaved={formatTaipei(s.updatedAt, false)}
            provider={{
              name: data.provider.isMock ? 'Mock Provider' : data.provider.name,
              monthlyQuota: quota,
              cap: quota === null ? null : quota - PROVIDER_SAFETY_MARGIN,
            }}
          />
          <PriceTargetsCard
            active={data.targets.map(toView)}
            history={data.targetHistory.map(toView)}
            currentPrice={data.latest && !data.stale ? data.latest.price : null}
            unitLabel={unit || '—'}
            isMock={data.provider.isMock}
            checkSummary={checkSummary}
          />
          {envStatus.telegram ? (
            <section className="card" aria-labelledby="subs-h">
              <div className="card-head">
                <div className="head-stack">
                  <p className="eyebrow">Telegram</p>
                  <h2 className="card-title" id="subs-h">Telegram 訂閱者</h2>
                </div>
                <span className="chip chip--muted">訂閱中 {activeSubscribers.length} 人</span>
              </div>
              {recentSubscribers.length === 0 ? (
                <p className="small soft">
                  {subscriptionOpen
                    ? `還沒有人訂閱。把 ${subscribeLink ?? 'bot 的連結'} 分享出去，對方按「開始」就會加入。`
                    : '開放訂閱後，任何人私訊 bot 傳 /start 就會出現在這裡。'}
                </p>
              ) : (
                <div className="table-wrap">
                  <table className="tbl tbl--stack">
                    <thead>
                      <tr><th>名稱</th><th>帳號</th><th>狀態</th><th>訂閱時間</th><th>操作</th></tr>
                    </thead>
                    <tbody>
                      {recentSubscribers.map((s) => (
                        <tr key={s.chatId}>
                          <td className="tbl__title">{s.name ?? '（未提供名字）'}<span className="cell-note num">{chatLabel(s.chatId)}</span></td>
                          <td data-label="帳號">{s.username ? `@${s.username}` : '—'}</td>
                          <td data-label="狀態"><span className={`chip ${SUBSCRIBER_STATUS[s.status][0]}`}>{SUBSCRIBER_STATUS[s.status][1]}</span></td>
                          <td className="num nowrap" data-label="訂閱時間">{formatTaipei(s.subscribedAt, false).slice(5)}</td>
                          <td data-label="操作">
                            {s.status === 'active' ? (
                              <ActionButton action={removeTelegramSubscriberAction} fields={{ chatId: s.chatId }} label="移除" variant="small" confirm="移除後不會再送給這個人；對方再傳 /start 會重新加入。確定要移除嗎？" />
                            ) : (
                              <span className="small soft">—</span>
                            )}
                          </td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}
              <p className="caption">只顯示最近 50 位。名字與 @username 是對方在 Telegram 上公開的資料，只在後台顯示；封鎖 bot 或刪除帳號的人會自動標成「無法傳送」，不再傳送；對方再傳 /start 會重新加入。</p>
            </section>
          ) : null}
          </div>

          <div className="col-side">
            <section className={`card card--tight tint ${envStatus.line ? 'tint--green' : 'tint--pink'}`} aria-labelledby="line-h">
              <div className="card-head" style={{ alignItems: 'flex-start' }}>
                <div className="head-stack">
                  <p className="eyebrow">LINE</p>
                  <h2 className="card-title" id="line-h">LINE 連線</h2>
                </div>
                <span className={`chip ${envStatus.line ? 'chip--ok' : 'chip--err'}`}>
                  <span className="dot" />
                  {envStatus.line ? '已設定' : '尚未連線'}
                </span>
              </div>
              <dl className="kv-list">
                <dt>Access Token</dt>
                <dd>{env.LINE_CHANNEL_ACCESS_TOKEN ? '已設定（只存在伺服器端）' : '未設定'}</dd>
                <dt>推播對象</dt>
                <dd>
                  {envStatus.line && envStatus.lineTarget === 'all' ? (
                    <>
                      官方帳號的所有好友（約 <span className="num">{data.recipients}</span> 人）
                      <span className="cell-note">人數取自 LINE 前一天的統計；每次推播每人算 1 則額度。改成只送指定的人：設定 LINE_TARGET=list 與 LINE_USER_ID</span>
                    </>
                  ) : recipientTails.length ? (
                    <>
                      {recipientTails.length} 人・末 4 碼 <span className="num">{recipientTails.join('、')}</span>
                      {recipientTails.length > 1 ? <span className="cell-note">每次推播每人算 1 則額度</span> : null}
                    </>
                  ) : env.LINE_USER_ID ? (
                    'User ID 格式不正確'
                  ) : (
                    '未設定'
                  )}
                </dd>
              </dl>
              {!envStatus.line ? (
                <p className="small">LINE 尚未連線，每日推播與提醒都只會記錄為「未發送」，不會假裝送出。設定步驟見 README。</p>
              ) : null}
              <div className="divider" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                <ActionButton action={testPushAction} label="發送測試推播" confirm={testConfirm} hint={testHint} />
                {lastTest ? (
                  <p className="small">
                    上次測試：<span className="num">{formatTaipei(lastTest.createdAt, false).slice(5)}</span> <EventStatusChip event={lastTest} />
                  </p>
                ) : null}
              </div>
            </section>

            <section className={`card card--tight${envStatus.telegram ? ' tint tint--green' : ''}`} aria-labelledby="tg-h">
              <div className="card-head" style={{ alignItems: 'flex-start' }}>
                <div className="head-stack">
                  <p className="eyebrow">Telegram</p>
                  <h2 className="card-title" id="tg-h">Telegram 連線</h2>
                </div>
                <span className={`chip ${envStatus.telegram ? 'chip--ok' : 'chip--muted'}`}>
                  <span className="dot" />
                  {envStatus.telegram ? '已設定' : '未設定（選用）'}
                </span>
              </div>
              <dl className="kv-list">
                <dt>Bot</dt>
                <dd>
                  {subscribeLink ? (
                    <a className="lnk" href={subscribeLink} target="_blank" rel="noopener noreferrer">@{botUsername}</a>
                  ) : env.TELEGRAM_BOT_TOKEN ? (
                    '已設定（只存在伺服器端）'
                  ) : (
                    '未設定'
                  )}
                </dd>
                {envStatus.telegram ? (
                  <>
                    <dt>訂閱</dt>
                    <dd>
                      {subscriptionOpen ? '開放中' : '尚未開放'}・訂閱中 <span className="num">{activeSubscribers.length}</span> 人
                      <span className="cell-note">Telegram 不限則數，不占 LINE 額度</span>
                    </dd>
                  </>
                ) : null}
                <dt>固定收件人</dt>
                <dd>
                  {telegramChats.length ? (
                    <>
                      {telegramChats.length} 個聊天室・<span className="num">{telegramChats.map(chatLabel).join('、')}</span>
                      <span className="cell-note">每日推播、提醒與測試推播都會送</span>
                    </>
                  ) : env.TELEGRAM_CHAT_ID ? (
                    '設定不完整，詳見系統狀態的設定檢查'
                  ) : (
                    <>
                      未設定<span className="cell-note">選填；測試推播只送固定收件人，要測試請填你自己的 chat ID</span>
                    </>
                  )}
                </dd>
              </dl>
              {!envStatus.telegram ? (
                <p className="small">選用。設定 TELEGRAM_BOT_TOKEN 後，每日推播與提醒會同時送到 Telegram 的訂閱者。設定步驟見 README。</p>
              ) : (
                <>
                  {webhookInfo?.lastErrorMessage && subscriptionOpen ? (
                    <div className="note note--warn">
                      <span>Telegram 最近一次呼叫 webhook 失敗：{webhookInfo.lastErrorMessage}</span>
                    </div>
                  ) : null}
                  <div className="divider" style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
                    <ActionButton
                      action={telegramTestPushAction}
                      label="只發送 Telegram 測試"
                      hint={telegramChats.length ? `只送給固定收件人（${telegramChats.length} 個聊天室），不會送給訂閱者，也不用 LINE 額度。` : '要先在 TELEGRAM_CHAT_ID 填你自己的 chat ID。'}
                    />
                    <ActionButton
                      action={setupTelegramWebhookAction}
                      label={subscriptionOpen ? '重新設定訂閱' : '開放訂閱'}
                      variant={subscriptionOpen ? 'small' : undefined}
                      confirm={subscriptionOpen ? undefined : '開放後，任何人私訊 bot 傳 /start 就會訂閱，並收到每日推播與提醒。確定要開放嗎？'}
                      hint={
                        subscriptionOpen
                          ? `訂閱連結：${subscribeLink ?? '（查不到 bot 名稱）'}，對方按「開始」就會加入。`
                          : webhookUrl
                            ? '任何人私訊 bot 傳 /start 就會訂閱、/stop 取消。'
                            : '需要公開的 https 網址，本機無法開放訂閱。'
                      }
                    />
                  </div>
                </>
              )}
            </section>

            {data.provider.isMock ? (
              <section className="card card--tight tint tint--yellow" aria-labelledby="mock-h">
                <div className="head-stack">
                  <p className="eyebrow">Mock</p>
                  <h2 className="card-title" id="mock-h">測試情境</h2>
                </div>
                <p className="small">只在使用 Mock Provider 時出現，用來測試上漲、下跌、過期與來源中斷的處理。先在「正常波動」建立今天的基準，再切到急漲或急跌。</p>
                <MockScenarioForm action={setMockScenarioAction} current={s.mockScenario} options={MOCK_SCENARIOS} />
              </section>
            ) : null}

            <section className="card card--tight" aria-labelledby="pv-daily-h">
              <div className="card-head">
                <h2 className="card-label" id="pv-daily-h">每日推播預覽</h2>
                {latestDaily?.status === 'mock' ? <span className="chip chip--mock">模擬資料</span> : null}
              </div>
              {dailyPreview ? <div className="msg">{dailyPreview}</div> : <p className="small soft">尚無每日快照，暫時無法預覽。</p>}
              {preview?.chartAvailable ? (
                // eslint-disable-next-line @next/next/no-img-element -- 動態產生的 PNG，跟 LINE 收到的是同一張
                <img className="msg-chart" src={chartPath(preview.date, 'compact')} alt={`截至 ${preview.date} 的近期金價走勢圖`} width={1040} height={585} loading="lazy" />
              ) : null}
              {latestDaily ? (
                <p className="caption">
                  取自 {latestDaily.dailyDate} 的每日快照。LINE 上是卡片樣式：漲跌上色（漲紅、跌綠），走勢圖在文字下方；
                  {envStatus.telegram ? 'Telegram 上是說明文字在上、走勢圖在下（價格與漲跌加粗），下方有「查看黃金走勢」按鈕；' : null}按「發送測試推播」可以看到實際樣子。
                </p>
              ) : null}
            </section>

            <section className="card card--tight" aria-labelledby="pv-alert-h">
              <div className="card-head">
                <h2 className="card-label" id="pv-alert-h">異動通知預覽</h2>
                {alertEvent?.messageText?.startsWith('【模擬資料】') ? <span className="chip chip--mock">模擬資料</span> : null}
              </div>
              {alertEvent?.messageText ? (
                <>
                  <div className="msg">{alertEvent.messageText}</div>
                  <p className="caption">取自最近一次異動事件（{formatTaipei(alertEvent.createdAt, false).slice(5)}）。</p>
                </>
              ) : (
                <p className="small soft">還沒有異動事件，達到門檻時會產生。</p>
              )}
            </section>
          </div>
        </div>
      </main>
    </>
  );
}

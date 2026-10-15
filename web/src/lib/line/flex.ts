import { formatPercent } from '../gold/math';
import { dailyFields, DIRECTION_MARK, REFERENCE_CHART_URL, type DailyMessageInput } from './messages';

// 每日推播的卡片（LINE Flex Message）。純文字訊息不能上色，卡片才能做到「下跌綠、上漲紅」。
// 欄位與數字都來自 dailyFields，跟純文字版完全一樣；資料無效時不做卡片，改送純文字。
// 格式：https://developers.line.biz/en/reference/messaging-api/#flex-message

export interface FlexMessage {
  type: 'flex';
  /** 通知列與聊天列表顯示的文字（卡片本身不會出現在通知裡） */
  altText: string;
  contents: Record<string, unknown>;
}

/** 卡片裡走勢圖（精簡版 1040×585）的比例 */
export const CARD_CHART_RATIO = '16:9';

const COLOR = {
  ink: '#222222',
  ink2: '#4D4D4D',
  ink3: '#666666',
  up: '#B42F3A',
  down: '#3B5E1F',
  warn: '#9A5B00',
  line: '#E9DCCB',
  link: '#9C7012',
};

const text = (value: string, style: Record<string, unknown> = {}) => ({ type: 'text', text: value, ...style });

export function buildDailyCard(i: DailyMessageInput, chartUrl: string | null): FlexMessage | null {
  const f = dailyFields(i);
  if (!f.valid) return null;
  const toneColor = f.tone === 'up' ? COLOR.up : f.tone === 'down' ? COLOR.down : COLOR.ink2;

  const details = f.rows.map(([label, value]) => ({
    type: 'box',
    layout: 'baseline',
    spacing: 'md',
    contents: [
      text(label, { size: 'sm', color: COLOR.ink3, flex: 0 }),
      text(value, { size: 'sm', color: label === '資料狀態' && f.warning ? COLOR.warn : COLOR.ink, wrap: true, align: 'end' }),
    ],
  }));

  const info = {
    type: 'box',
    layout: 'vertical',
    paddingAll: '20px',
    contents: [
      text(f.title, { weight: 'bold', size: 'lg', color: COLOR.ink, wrap: true }),
      ...(f.date ? [text(f.date, { size: 'sm', color: COLOR.ink3, margin: 'xs' })] : []),
      text(f.instrument, { size: 'sm', color: COLOR.ink2, margin: 'xl' }),
      {
        type: 'box',
        layout: 'baseline',
        margin: 'xs',
        contents: [text(f.price, { size: 'xxl', weight: 'bold', color: COLOR.ink, flex: 0 }), text(f.unit, { size: 'sm', color: COLOR.ink3, margin: 'md' })],
      },
      ...(f.change ? [text(f.change, { size: 'md', weight: 'bold', color: toneColor, margin: 'sm' })] : []),
      { type: 'separator', margin: 'xl', color: COLOR.line },
      { type: 'box', layout: 'vertical', spacing: 'sm', margin: 'xl', contents: details },
    ],
  };

  // 走勢圖放在文字下方、按鈕上方，左右貼齊卡片邊緣；點圖片可以開大圖
  const chart = chartUrl
    ? [{ type: 'image', url: chartUrl, size: 'full', aspectRatio: CARD_CHART_RATIO, aspectMode: 'cover', action: { type: 'uri', label: '查看走勢圖', uri: chartUrl } }]
    : [];

  const percent =
    f.tone && i.changePercent !== null
      ? ` ${DIRECTION_MARK[f.tone]}${f.tone === 'flat' ? '0.00%' : formatPercent(Math.abs(i.changePercent)).slice(1)}`
      : '';

  return {
    type: 'flex',
    altText: `${f.title} ${f.price} ${i.currency}${percent}`,
    contents: {
      type: 'bubble',
      size: 'mega',
      body: { type: 'box', layout: 'vertical', paddingAll: '0px', contents: [info, ...chart] },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [{ type: 'button', style: 'link', height: 'sm', color: COLOR.link, action: { type: 'uri', label: '查看黃金走勢', uri: REFERENCE_CHART_URL } }],
      },
      styles: { footer: { separator: true, separatorColor: COLOR.line } },
    },
  };
}

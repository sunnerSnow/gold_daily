// Gold Daily 推廣素材共用：logo、插畫（金條、金幣、小人、手機、漲跌記號）、紙張質感濾鏡與 bot 名稱。
// promo.html（靜態圖）與 video.html（影片）都在 <body> 一開始載入這個檔案，改 logo 或插畫只要改這裡。

window.GOLD_DAILY = {
  // 填 bot 的 username（@ 後面那串）就會顯示真的名稱並產生 QR code；留空時顯示預留位置
  bot: 'GoldEchoBot',

  /** 把頁面上的 [data-bot] 換成 bot 名稱、[data-qr] 換成訂閱連結的 QR code */
  fillBotAndQr() {
    const bot = this.bot;
    for (const el of document.querySelectorAll('[data-bot]')) el.textContent = bot ? `@${bot}` : '@[你的 bot 名稱]';
    for (const el of document.querySelectorAll('[data-qr]')) {
      if (bot && window.qrcode) {
        const qr = qrcode(0, 'M');
        qr.addData(`https://t.me/${bot}`);
        qr.make();
        el.innerHTML = qr.createSvgTag(4, 0);
      } else {
        el.classList.add('empty');
        el.innerHTML = 'QR code<br>（填入 bot 名稱）';
      }
    }
  },
};

document.body.insertAdjacentHTML('afterbegin', `
<svg aria-hidden="true" style="position: absolute; width: 0; height: 0">
  <defs>
    <filter id="rough" x="-10%" y="-10%" width="120%" height="120%">
      <feTurbulence type="fractalNoise" baseFrequency="0.035" numOctaves="2" seed="3" result="n"></feTurbulence>
      <feDisplacementMap in="SourceGraphic" in2="n" scale="4" xChannelSelector="R" yChannelSelector="G"></feDisplacementMap>
    </filter>
    <filter id="soft"><feGaussianBlur stdDeviation="0.9"></feGaussianBlur></filter>
    <filter id="grain-dark" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.9" numOctaves="2" seed="4" stitchTiles="stitch"></feTurbulence>
      <feColorMatrix values="0 0 0 0 0.42  0 0 0 0 0.27  0 0 0 0 0.08  2.4 0 0 0 -1.32"></feColorMatrix>
    </filter>
    <filter id="grain-light" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.7" numOctaves="2" seed="11" stitchTiles="stitch"></feTurbulence>
      <feColorMatrix values="0 0 0 0 1  0 0 0 0 0.98  0 0 0 0 0.92  2.4 0 0 0 -1.38"></feColorMatrix>
    </filter>
    <filter id="mottle" x="0" y="0" width="100%" height="100%">
      <feTurbulence type="fractalNoise" baseFrequency="0.012" numOctaves="3" seed="2"></feTurbulence>
      <feColorMatrix values="0 0 0 0 0.78  0 0 0 0 0.52  0 0 0 0 0.12  0 0 0 1.3 -0.6"></feColorMatrix>
    </filter>

    <!-- 等角金條：O 在最上方的後角 -->
    <g id="bar">
      <polygon points="103.9,60 55.4,88 55.4,46 90.1,26" fill="#D9A13A" stroke="#B07A1E" stroke-width="1.5" stroke-linejoin="round"></polygon>
      <polygon points="-48.5,28 55.4,88 55.4,46 -34.7,-6" fill="#F2C66B" stroke="#B07A1E" stroke-width="1.5" stroke-linejoin="round"></polygon>
      <polygon points="0,-26 90.1,26 55.4,46 -34.7,-6" fill="#FBE3A2" stroke="#B07A1E" stroke-width="1.5" stroke-linejoin="round"></polygon>
      <path d="M4 -5 L52 22" stroke="#FFF6DC" stroke-width="5" stroke-linecap="round"></path>
    </g>

    <g id="coin">
      <ellipse cx="0" cy="6" rx="28" ry="15" fill="#C98F27"></ellipse>
      <ellipse cx="0" cy="0" rx="28" ry="15" fill="#E9AE40"></ellipse>
      <ellipse cx="0" cy="0" rx="9" ry="5" fill="#FFFDF8"></ellipse>
    </g>
    <g id="coin-light">
      <ellipse cx="0" cy="6" rx="28" ry="15" fill="#DCD5C9"></ellipse>
      <ellipse cx="0" cy="0" rx="28" ry="15" fill="#FFFDF8"></ellipse>
      <ellipse cx="0" cy="0" rx="9" ry="5" fill="#E9AE40"></ellipse>
    </g>

    <!-- 小人 A：芥末色毛衣、白褲子，右手往前指（腳底中心在 0,0） -->
    <g id="person-a">
      <ellipse cx="0" cy="2" rx="46" ry="12" fill="#DCD5C9"></ellipse>
      <ellipse cx="-13" cy="-4" rx="14" ry="8" fill="#231815"></ellipse>
      <ellipse cx="13" cy="-4" rx="14" ry="8" fill="#231815"></ellipse>
      <path d="M-23 -10 L-24 -66 L24 -66 L23 -10 Q22 -6 16 -6 L4 -6 L1 -42 L-1 -42 L-4 -6 L-16 -6 Q-22 -6 -23 -10 Z" fill="#FFFFFF" stroke="#E3B866" stroke-width="2" stroke-linejoin="round"></path>
      <path d="M-27 -108 Q-42 -88 -36 -70" fill="none" stroke="#E9AE40" stroke-width="16" stroke-linecap="round"></path>
      <circle cx="-36" cy="-64" r="8" fill="#F7D7A1"></circle>
      <path d="M-31 -60 Q-35 -110 -16 -118 L16 -118 Q35 -110 31 -60 Q0 -54 -31 -60 Z" fill="#E9AE40"></path>
      <path d="M26 -108 Q50 -104 68 -98" fill="none" stroke="#E9AE40" stroke-width="16" stroke-linecap="round"></path>
      <circle cx="74" cy="-97" r="8" fill="#F7D7A1"></circle>
      <rect x="-6" y="-128" width="12" height="12" fill="#F7D7A1"></rect>
      <circle cx="0" cy="-143" r="21" fill="#F7D7A1"></circle>
      <path d="M-23 -140 Q-25 -168 0 -167 Q25 -168 23 -140 L23 -127 Q19 -122 15 -127 L15 -147 Q0 -152 -15 -147 L-15 -127 Q-19 -122 -23 -127 Z" fill="#231815"></path>
    </g>

    <!-- 小人 B：白毛衣、芥末色褲子，雙手把金條舉過頭 -->
    <g id="person-b">
      <ellipse cx="0" cy="2" rx="46" ry="12" fill="#DCD5C9"></ellipse>
      <ellipse cx="-13" cy="-4" rx="14" ry="8" fill="#231815"></ellipse>
      <ellipse cx="13" cy="-4" rx="14" ry="8" fill="#231815"></ellipse>
      <path d="M-23 -10 L-24 -66 L24 -66 L23 -10 Q22 -6 16 -6 L4 -6 L1 -42 L-1 -42 L-4 -6 L-16 -6 Q-22 -6 -23 -10 Z" fill="#D39A2E"></path>
      <path d="M-25 -106 Q-36 -146 -24 -178" fill="none" stroke="#E3B866" stroke-width="19" stroke-linecap="round"></path>
      <path d="M25 -106 Q36 -146 24 -178" fill="none" stroke="#E3B866" stroke-width="19" stroke-linecap="round"></path>
      <path d="M-25 -106 Q-36 -146 -24 -178" fill="none" stroke="#FFFFFF" stroke-width="15" stroke-linecap="round"></path>
      <path d="M25 -106 Q36 -146 24 -178" fill="none" stroke="#FFFFFF" stroke-width="15" stroke-linecap="round"></path>
      <path d="M-31 -60 Q-35 -110 -16 -118 L16 -118 Q35 -110 31 -60 Q0 -54 -31 -60 Z" fill="#FFFFFF" stroke="#E3B866" stroke-width="2" stroke-linejoin="round"></path>
      <rect x="-6" y="-128" width="12" height="12" fill="#F7D7A1"></rect>
      <circle cx="0" cy="-143" r="21" fill="#F7D7A1"></circle>
      <circle cx="0" cy="-170" r="10" fill="#231815"></circle>
      <path d="M-22 -140 Q-24 -166 0 -165 Q24 -166 22 -140 Q12 -150 0 -150 Q-12 -150 -22 -140 Z" fill="#231815"></path>
      <use href="#bar" transform="translate(-15.2 -236) scale(0.55)"></use>
      <circle cx="-24" cy="-182" r="8" fill="#F7D7A1"></circle>
      <circle cx="24" cy="-182" r="8" fill="#F7D7A1"></circle>
    </g>

    <!-- 平躺的手機（本地座標 340×640，外面再套等角變形）：螢幕上是一則每日行情，文字在上、走勢圖在下、按鈕 -->
    <g id="phone">
      <rect width="340" height="640" rx="44" fill="#231815"></rect>
      <rect x="16" y="16" width="308" height="608" rx="32" fill="#FFFDF8"></rect>
      <rect x="140" y="30" width="60" height="10" rx="5" fill="#231815"></rect>
      <rect x="38" y="70" width="264" height="420" rx="22" fill="#F3E9D9"></rect>
      <rect x="58" y="94" width="140" height="16" rx="8" fill="#231815"></rect>
      <rect x="58" y="124" width="196" height="9" rx="4.5" fill="#C9BFAF"></rect>
      <rect x="58" y="141" width="150" height="9" rx="4.5" fill="#C9BFAF"></rect>
      <rect x="58" y="164" width="172" height="26" rx="8" fill="#E9AE40"></rect>
      <path d="M58 220 L68 204 L78 220 Z" fill="#231815"></path>
      <rect x="86" y="208" width="92" height="10" rx="5" fill="#C98F27"></rect>
      <rect x="58" y="238" width="224" height="150" rx="12" fill="#FFFDF8"></rect>
      <path d="M70 362 L98 348 L124 354 L150 322 L176 332 L204 298 L230 306 L266 266 L266 378 L70 378 Z" fill="#F2C66B" fill-opacity="0.6"></path>
      <polyline points="70,362 98,348 124,354 150,322 176,332 204,298 230,306 266,266" fill="none" stroke="#D39A2E" stroke-width="6" stroke-linecap="round" stroke-linejoin="round"></polyline>
      <circle cx="266" cy="266" r="8" fill="#231815"></circle>
      <rect x="58" y="404" width="224" height="44" rx="22" fill="#E9AE40"></rect>
      <rect x="122" y="421" width="96" height="10" rx="5" fill="#231815"></rect>
      <rect x="130" y="596" width="80" height="7" rx="3.5" fill="#C9BFAF"></rect>
    </g>

    <!-- 漂浮記號：取代參考網站的音符，改成漲跌與走勢 -->
    <g id="mark-up" fill="#231815">
      <circle cx="0" cy="40" r="10"></circle>
      <path d="M18 52 L46 -2" stroke="#231815" stroke-width="5" stroke-linecap="round" opacity="0.8"></path>
      <path d="M58 30 L80 -10 L102 30 Z"></path>
    </g>
    <g id="mark-zig" fill="none" stroke="#231815" stroke-width="7" stroke-linecap="round" stroke-linejoin="round">
      <polyline points="0,40 22,18 40,30 70,-4"></polyline>
      <polyline points="52,-4 70,-4 70,14"></polyline>
    </g>

    <!-- logo：圓頭粗筆畫 GOLD（O 是一枚金幣）＋斜體 daily＋「每日金價」（370×215） -->
    <g id="logo">
      <g fill="none" stroke="#231815" stroke-width="26" stroke-linecap="round" stroke-linejoin="round">
        <path d="M76.2 23.8 A37 37 0 1 0 87 50 L60 50"></path>
        <path d="M226 13 V87 H272"></path>
        <path d="M304 13 V87 H320 A37 37 0 0 0 320 13 Z"></path>
      </g>
      <circle cx="158" cy="50" r="40" fill="#FFFDF8" stroke="#231815" stroke-width="12"></circle>
      <circle cx="158" cy="50" r="12" fill="#231815"></circle>
      <text x="370" y="160" text-anchor="end" font-family="'Cormorant Garamond', serif" font-style="italic" font-weight="700" font-size="74" fill="#231815">daily</text>
      <rect x="14" y="196" width="100" height="3" fill="#231815"></rect>
      <rect x="256" y="196" width="100" height="3" fill="#231815"></rect>
      <text x="190" y="206" text-anchor="middle" font-family="'Noto Serif TC', serif" font-weight="700" font-size="24" letter-spacing="10" fill="#231815">每日金價</text>
    </g>

    <!-- 「VIEW MORE」式的手繪線＋筆尖 -->
    <g id="pen-line">
      <path d="M2 24 Q 70 20 130 23 T 236 21" fill="none" stroke="#231815" stroke-width="2.2" stroke-linecap="round"></path>
      <path d="M226 30 L246 4 Q250 1 249 7 L233 32 Z" fill="none" stroke="#231815" stroke-width="2" stroke-linejoin="round"></path>
      <path d="M233 32 L229 38" stroke="#231815" stroke-width="2" stroke-linecap="round"></path>
    </g>
  </defs>
</svg>
`);

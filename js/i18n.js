// ─────────── i18n: EN / KO with auto-detect + localStorage cache ───────────
const dict = {
  en: {
    tagline1: 'Auto-crop that follows the climber',
    tagline2: 'Upload a fixed-camera climbing video and your browser tracks the climber and edits it into a vertical clip.',
    dropTitle: 'Drop your climbing video here',
    dropSub: 'or click to browse — MP4 · MOV · WebM',
    privacy: '100% local processing — your video never leaves your device.',
    feat1: 'AI climber tracking',
    feat2: '100% on-device',
    feat3: '9:16 · 5:4 · 1:1',
    settings: 'Settings',
    aspect: 'Aspect ratio',
    cropSize: 'Crop size (zoom)',
    zoomTight: 'tight', zoomWide: 'full view',
    smoothness: 'Motion smoothness',
    smoothLow: 'dynamic', smoothHigh: 'smooth',
    introZoom: 'Intro zoom (full view → close-up)',
    setHere: 'Set to playhead',
    zoomDur: 'Zoom-in duration',
    skeleton: 'Pose overlay',
    skelOff: 'Off', skelIntro: 'Intro only', skelAlways: 'Always',
    speed: 'Speed sections (slow-mo / fast-forward)',
    addSpeed: 'Add section at playhead',
    speedHint: 'Audio pitch is preserved — only the speed changes.',
    branding: 'Branding watermark (bottom-right)',
    showLogo: 'ClimbCrop logo',
    difficulty: 'Grade colour',
    gymLogo: 'Gym logo (optional)',
    gymUpload: 'Upload your logo',
    gymLoadFail: 'Could not load that image.',
    analyze: 'Analyze climber',
    export: 'Export video',
    startOver: 'Start over',
    backToEdit: 'Back to editing',
    viewFull: 'Original', viewCrop: 'Cropped',
    trimLabel: 'Trim in/out',
    climbStartShort: 'Climb start',
    seedHint: '💡 Tap the main climber on the first frame',
    pickOnFirst: 'Tap the main climber on the first frame.',
    processingNote: 'Keep this tab visible while it works.',
    eta: 'About {s}s left — keep this tab visible.',
    cancel: 'Cancel',
    adPh: 'AD SPACE',
    analyzing: 'Finding your climber…',
    loadingModel: 'Getting ready…',
    loadingVideo: 'Loading video…',
    videoLoadFail: 'Could not open this video — the codec may be unsupported (e.g. iPhone HEVC). Try converting to H.264 MP4, or use the latest Chrome/Edge.',
    exporting: 'Creating your video…',
    resultTitle: '🎉 Your video is ready!',
    download: 'Download',
    share: 'Share',
    shareHint: 'On mobile, the Share button sends straight to Instagram or KakaoTalk.',
    shareNoFiles: 'File sharing is not supported in this browser — download the video and share it manually.',
    analyzeFirst: 'Tap “Analyze climber” before exporting.',
    analyzeDone: 'Found your climber — check the crop preview.',
    analyzeLow: 'Couldn’t lock onto the climber — tap them on the first frame and try again.',
    reanalyze: 'Re-run analysis to apply this.',
    canceled: 'Canceled.',
    exportFail: 'Export failed: ',
    speedStart: 'start', speedEnd: 'end',
  },
  ko: {
    tagline1: 'ClimbCrop',
    tagline2: '등반 영상을 올리면 클라이머를 자동 추적해 크롭·편집해 드립니다!',
    dropTitle: '여기에 영상을 끌어다 놓으세요',
    dropSub: '또는 클릭해서 선택 — MP4 · MOV · WebM',
    privacy: '영상은 서버로 업로드되지 않습니다.',
    feat1: 'AI 클라이머 추적',
    feat2: '100% 기기 내 처리',
    feat3: '9:16 · 5:4 · 1:1',
    settings: '설정',
    aspect: '화면비',
    cropSize: '크롭 크기 (줌)',
    zoomTight: '타이트', zoomWide: '전체 뷰',
    smoothness: '움직임 부드러움',
    smoothLow: '다이나믹', smoothHigh: '부드럽게',
    introZoom: '인트로 줌 (전체 뷰 → 확대)',
    setHere: '현재 위치로 설정',
    zoomDur: '확대 시간',
    skeleton: '자세 오버레이',
    skelOff: '끄기', skelIntro: '시작만', skelAlways: '항상',
    speed: '배속 구간 (슬로모 / 빨리감기)',
    addSpeed: '현재 위치에 구간 추가',
    speedHint: '오디오 피치는 유지된 채 속도만 변합니다.',
    branding: '브랜딩 워터마크 (오른쪽 아래)',
    showLogo: 'ClimbCrop 로고',
    difficulty: '난이도 색',
    gymLogo: '암장 로고 (선택)',
    gymUpload: '내 로고 업로드',
    gymLoadFail: '이미지를 불러오지 못했어요.',
    analyze: '클라이머 분석',
    export: '영상 내보내기',
    startOver: '처음부터 다시',
    backToEdit: '편집으로 돌아가기',
    viewFull: '원본', viewCrop: '크롭',
    trimLabel: '시작/끝 트림',
    climbStartShort: '등반 시작',
    seedHint: '💡 첫 프레임에서 주인공을 탭하면 더 정확해요',
    pickOnFirst: '첫 프레임에서 주인공을 탭하세요.',
    processingNote: '처리 중에는 이 탭을 화면에 유지해 주세요.',
    eta: '약 {s}초 남음 — 이 탭을 화면에 유지해 주세요.',
    cancel: '취소',
    adPh: '광고 영역',
    analyzing: '주인공을 찾는 중…',
    loadingModel: '준비 중…',
    loadingVideo: '영상 불러오는 중…',
    videoLoadFail: '영상을 열 수 없어요 — 코덱 미지원일 수 있어요(예: 아이폰 HEVC). H.264 MP4로 변환하거나 최신 Chrome/Edge를 사용해 주세요.',
    exporting: '영상을 만드는 중…',
    resultTitle: '🎉 영상이 완성됐어요!',
    download: '다운로드',
    share: '공유',
    shareHint: '모바일에서는 공유 버튼으로 인스타그램·카카오톡에 바로 보낼 수 있어요.',
    shareNoFiles: '이 브라우저는 파일 공유를 지원하지 않아요 — 다운로드 후 직접 공유해 주세요.',
    analyzeFirst: '내보내기 전에 “클라이머 분석”을 먼저 눌러 주세요.',
    analyzeDone: '주인공을 찾았어요 — 크롭을 확인해 보세요.',
    analyzeLow: '주인공을 잘 못 찾았어요 — 첫 프레임에서 주인공을 탭한 뒤 다시 시도해 주세요.',
    reanalyze: '다시 분석하면 반영돼요.',
    canceled: '취소되었습니다.',
    exportFail: '내보내기 실패: ',
    speedStart: '시작', speedEnd: '끝',
  },
};

let lang = 'en';

export function detectLang() {
  const saved = localStorage.getItem('climbcrop-lang');
  if (saved === 'ko' || saved === 'en') return saved;
  const nav = (navigator.language || navigator.userLanguage || 'en').toLowerCase();
  return nav.startsWith('ko') ? 'ko' : 'en';
}

export function getLang() { return lang; }

export function setLang(l) {
  lang = l;
  localStorage.setItem('climbcrop-lang', l);
  applyI18n();
}

export function t(key, vars) {
  let s = dict[lang][key] ?? dict.en[key] ?? key;
  if (vars) for (const [k, v] of Object.entries(vars)) s = s.replace(`{${k}}`, v);
  return s;
}

export function applyI18n() {
  document.documentElement.lang = lang;
  document.querySelectorAll('[data-i18n]').forEach(el => { el.textContent = t(el.dataset.i18n); });
  const btn = document.getElementById('langBtn');
  if (btn) btn.textContent = lang === 'ko' ? '🇰🇷 한국어' : '🇺🇸 English';
}

export function initI18n() {
  lang = detectLang();
  applyI18n();
  const btn = document.getElementById('langBtn');
  btn.addEventListener('click', () => setLang(lang === 'ko' ? 'en' : 'ko'));
}

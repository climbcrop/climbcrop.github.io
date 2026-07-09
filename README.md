# 🧗 ClimbCrop

고정 시점 등반 영상을 올리면 **브라우저 안에서** 클라이머를 자동 추적해 세로 클립으로 크롭·편집해 주는 웹앱.
서버 없음 — 모든 처리(AI 포즈 추적, 렌더링, 인코딩)는 사용자의 브라우저/GPU에서 수행됩니다.

## 기능
- 🎯 MediaPipe Pose 기반 메인 클라이머 추적 (다인 촬영 시 주인공 고정, 미감지 프레임 보간)
- 📐 화면비 프리셋: 9:16(1080×1920) · 5:4(1080×1350, 기본) · 1:1(1080×1080) — 크롭박스는 항상 프레임 안에 유지
- 🎚️ 크롭 크기(줌)·움직임 부드러움 조절 슬라이더
- 🎬 인트로 줌: 등반 시작 전 전체 뷰 → 서서히 확대 (시작 지점 🚩 마커 + 확대 시간 조절)
- ✂️ 시작/끝 트림, 타임라인 스크럽 + 필름스트립 썸네일
- 🐢⚡ 배속 구간 (0.25×–4×, 오디오 피치 유지)
- 🦴 스켈레톤 오버레이 (끄기 / 시작만 / 항상)
- 🔊 오디오 보존 (내보내기 시 원본 오디오 포함)
- 📤 완성 후 시스템 공유(모바일에서 인스타그램·카카오톡) + 다운로드
- 🌐 한/영 자동 감지 + 국기 토글 (localStorage 캐시)

## 로컬 실행
빌드 스텝 없음. 정적 서버만 있으면 됩니다 (ES 모듈 때문에 `file://`로는 안 됨):

```bash
cd climbcrop
python serve.py 8787
# → http://localhost:8787
```

> ⚠️ `python -m http.server`를 쓰지 마세요 — Windows 레지스트리에 `.js`가 `text/plain`으로 등록된 경우
> ES 모듈 로드가 MIME 검사에서 차단됩니다. `serve.py`가 올바른 MIME 타입을 강제합니다.
> (GitHub Pages는 MIME을 올바르게 서빙하므로 배포에는 영향 없음)

**요구 브라우저**: Chrome/Edge 최신 버전 권장 (MediaRecorder MP4, requestVideoFrameCallback, WebGPU/WASM).

## GitHub Pages 배포
1. GitHub에 새 저장소 생성 (예: `climbcrop`)
2. ```bash
   cd climbcrop
   git init && git add -A && git commit -m "ClimbCrop v1"
   git branch -M main
   git remote add origin https://github.com/<계정>/climbcrop.git
   git push -u origin main
   ```
3. 저장소 **Settings → Pages → Source: Deploy from a branch → main / (root)** 선택
4. 몇 분 뒤 `https://<계정>.github.io/climbcrop/` 에서 접속

모든 경로가 상대 경로라 서브패스에서도 그대로 동작합니다.

## 배포 전 체크리스트
- **Google AdSense**: `index.html`의 `<head>` 주석과 `.ad-slot` 안 주석을 실제 클라이언트 ID/광고 유닛으로 교체. AdSense는 도메인 심사가 필요하므로 Pages 배포 후 사이트 등록 → 루트에 `ads.txt` 추가.
- **KakaoTalk 공유 고도화(선택)**: 현재는 시스템 공유 시트를 사용. 카카오 전용 버튼을 원하면 [Kakao Developers](https://developers.kakao.com)에서 JS 키 발급 + 사이트 도메인 등록 후 Kakao SDK `Kakao.Share` 연동.
- **HTTPS**: GitHub Pages는 기본 HTTPS — Web Share API(파일 공유)와 AudioContext에 필요하므로 커스텀 도메인 사용 시에도 HTTPS 유지.
- CDN 의존성: MediaPipe(`cdn.jsdelivr.net`)와 모델(`storage.googleapis.com`)을 런타임에 로드 — 완전 오프라인이 필요하면 두 파일을 저장소에 받아 경로만 바꾸면 됨 (`js/tracker.js` 상단 상수).

## 구조
```
climbcrop/
├── index.html        # 마크업 + 광고 슬롯 자리
├── css/style.css     # 글래스모피즘 디자인
└── js/
    ├── app.js        # UI·상태·타임라인·미리보기·공유
    ├── tracker.js    # MediaPipe 포즈 추적 + 크롭 경로(스무딩/클램프)
    ├── exporter.js   # Canvas 캡처 + 오디오 그래프 → MediaRecorder
    └── i18n.js       # 한/영 사전, 자동 감지 + 캐시
```

## 동작 원리
1. **분석**: 트림 구간을 8fps로 샘플링하며 MediaPipe Pose(최대 4인)를 실행. 이전 위치에 가장 가까운 인물만 주인공으로 선택(다른 사람에게 점프 금지), 미감지 프레임은 앞뒤 감지값으로 보간.
2. **경로**: 토르소 중심 좌표를 박스 블러 다중 패스로 스무딩(슬라이더로 창 크기 조절), 크롭박스는 화면비 잠금 + 프레임 경계 클램프. 등반 시작 마커 전에는 전체 뷰, 이후 smoothstep으로 확대.
3. **내보내기**: 영상을 실시간 재생하며(배속 구간은 `playbackRate`, 피치 유지) 크롭 프레임을 캔버스에 그리고, `canvas.captureStream` + Web Audio 그래프 오디오를 MediaRecorder로 인코딩 → MP4(지원 시) 또는 WebM.

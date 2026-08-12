# Core CPI ex-Shelter

미국 소비자물가에서 식료품·에너지·주거비를 제외한 근원물가(CPI less food, shelter, and energy)의
1968년 이후 추이를 보여주는 정적 사이트입니다.

## 실행

```bash
npm run fetch    # BLS/FRED에서 데이터를 받아 public/data.js 생성
npm start        # http://localhost:5173
```

데이터를 한 번 받아두면 `public/index.html`을 브라우저로 직접 열어도 동작합니다
(데이터를 `.json`이 아니라 `data.js`로 굽는 이유가 이것입니다 — `file://`에서는 fetch가 막힙니다).

## 자동 갱신

`.github/workflows/update.yml` 이 **매일 14:20 UTC**(미 동부 오전 9:20 / 겨울 10:20)에 실행됩니다.
CPI는 보통 미 동부 오전 8:30에 발표되므로 그 뒤입니다.

발표일에만 맞추지 않고 매일 도는 이유는, BLS 발표일이 매달 바뀌고 수정발표(revision)가 비정기적으로
나오며 매년 1월에 계절조정 계수가 재산정되기 때문입니다. 대신 **값이 실제로 바뀌었을 때만 커밋**합니다 —
`generatedAt` 타임스탬프는 데이터가 변했을 때만 갱신되므로, 변화가 없는 날은 출력 파일이 바이트 단위로
동일해 아무 기록도 남지 않습니다.

값이 바뀌면 `data: refresh through YYYY-MM` 커밋이 생기고 GitHub Pages가 재배포됩니다.

### 필요한 설정

| 시크릿 | 필수 | 용도 |
|---|---|---|
| `FRED_API_KEY` | 예 | Sticky 계열과 `USREC` |
| `BLS_API_KEY` | 아니오 | 있으면 BLS API v2 사용 |

`BLS_API_KEY`는 없어도 동작합니다(키 없는 v1로 폴백). 다만 v1은 **IP당** 하루 25회 제한이라
공유 IP를 쓰는 CI 러너에서는 남의 워크플로우와 한도를 나눠 쓰게 됩니다.
[bls.gov/developers](https://www.bls.gov/developers/)에서 무료 키를 받아 등록하면 v2로 올라가
요청당 20년(요청 6회 → 3회), 하루 500회로 늘고 한도가 IP가 아닌 키에 붙습니다.

```bash
gh secret set BLS_API_KEY --body '<발급받은 키>'
```

> GitHub은 저장소가 60일간 활동이 없으면 예약 워크플로우를 자동으로 비활성화합니다.
> CPI가 매달 나오니 보통은 커밋이 계속 생겨 문제없지만, 오래 조용하면 재활성화 안내 메일이 옵니다.

수동으로 돌리려면 Actions 탭에서 **Run workflow**, 또는:

```bash
gh workflow run "Update CPI data & deploy"
```

## 데이터 출처

| 계열 | ID | 출처 |
|---|---|---|
| CPI less food, shelter, and energy | `CUUR0000SA0L12E` / `CUSR0000SA0L12E` | BLS |
| CPI less food and energy (Core) | `CUUR0000SA0L1E` / `CUSR0000SA0L1E` | BLS |
| CPI all items (헤드라인) | `CUUR0000SA0` / `CUSR0000SA0` | BLS |
| CPI shelter (주거비) | `CUUR0000SAH1` / `CUSR0000SAH1` | BLS |
| Sticky Price CPI less food, energy, shelter — 전년 대비 | `CRESTKCPIXSLTRM159SFRBATL` | FRED (애틀랜타 연준) |
| Sticky Price CPI less food, energy, shelter — 3개월 연율화 | `CRESTKCPIXSLTRM679SFRBATL` | FRED (애틀랜타 연준) |
| NBER 경기침체 구간 | `USREC` | FRED |

**BLS가 1차 출처입니다.** FRED는 BLS를 미러링한 것이고, 무엇보다
`CUUR0000SA0L12E`(주거비 제외 근원물가)를 **FRED는 아예 제공하지 않습니다**.
따라서 이 사이트의 핵심 지표는 BLS가 유일한 출처이고, FRED는 헤드라인·Core·주거비의
폴백 및 `USREC` 용도로만 씁니다.

- BLS Public Data API v1: 키 불필요, 요청당 10년 / 시리즈 25개, IP당 하루 25회.
  `scripts/fetch-data.mjs`는 10년 단위 6회 요청으로 1967~현재를 모두 받습니다.
- FRED API 키는 `.env`의 `FRED_API_KEY`에서 읽습니다. 빌드 시점에만 쓰이고
  브라우저로 나가지 않습니다. `.env`는 `.gitignore`에 있습니다.

원본 API 응답은 `data/.cache/`에 저장되어 재실행 시 BLS 일일 한도를 소모하지 않습니다.
강제로 다시 받으려면 `node scripts/fetch-data.mjs --fresh`.

## 계산 방식

- **전년 대비(YoY)** — 계절조정 전(NSA) 지수. `(x[t] / x[t-12] - 1) × 100`
- **3·6개월 연율화** — 계절조정(SA) 지수. `((x[t] / x[t-n])^(12/n) - 1) × 100`
- **Sticky 계열** — 계산하지 않습니다. FRED가 지수(index)가 아니라 이미 변화율로 발표하기
  때문에 발표값을 그대로 씁니다. 계절조정(SA) 기준이라 BLS의 NSA 기반 YoY와 계절조정
  처리가 다릅니다.

## 데이터상 주의점

- **2025년 10월은 값이 없습니다.** 연방정부 셧다운으로 조사가 이루어지지 않았습니다
  (BLS 각주: *"Data unavailable due to the 2025 lapse in appropriations"*).
  보간하지 않고 선을 끊었으며, 이 결측은 3·6개월 연율화로도 전파됩니다.
  **단 Sticky 계열은 이 달에도 값(2.70%)이 있습니다.** BLS가 발표하지 않은 달인데 FRED에는
  애틀랜타 연준 값이 실려 있어서, 차트에서 Sticky 선만 끊기지 않습니다. 임의로 지우지 않고
  발표된 그대로 두되 `data/cpi.json`의 `missingButSticky`에 해당 월을 기록합니다.
- **Sticky CPI는 항목을 빼는 게 아니라 가중치를 다시 주는 지표입니다.** 애틀랜타 연준이
  CPI 구성 항목을 가격 변경 빈도로 나눠, 잘 안 변하는(평균 4.3개월 이상 고정) 항목에
  가중치를 몰아준 지수입니다. 여기 쓴 것은 그중 식료품·에너지·주거비를 뺀 버전이라
  대상 범위는 BLS 핵심 지표와 같고 가중 방식만 다릅니다.
- **1983년 주거비 정의 변경.** 그 이전 CPI 주거비는 주택 가격과 모기지 이자를 직접 포함했고
  이후 자가주거비 등가임대료(OER)로 바뀌었습니다. 1970~80년대 초 구간은 현재와 같은
  기준으로 비교할 수 없습니다. 이 지표의 최고점이 1980년이 아니라 1975년 2월(11.68%)인
  이유이기도 합니다.

## 구조

```
scripts/fetch-data.mjs   데이터 수집 → data/cpi.json, public/data.js
scripts/serve.mjs        의존성 없는 정적 서버
public/index.html        마크업
public/styles.css        팔레트(라이트/다크 각각 검증됨) 및 레이아웃
public/app.js            SVG 차트 엔진, 필터, 툴팁, 테이블 뷰
```

의존성 없음 — `npm install` 불필요합니다.

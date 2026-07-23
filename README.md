# Pet Ad Collector

Meta 광고 라이브러리에서 등록된 경쟁사 광고를 수집해 펫 광고 레퍼런스 대시보드로 전송합니다.

## 실행 시간

- 매일 한국시간 오전 9시
- 매일 한국시간 오후 9시
- GitHub Actions 화면에서 수동 실행 가능

## 필요한 Actions secrets

Repository settings → Secrets and variables → Actions에 아래 3개를 등록합니다.

- `DASHBOARD_URL`
- `COLLECTOR_INGEST_TOKEN`
- `DASHBOARD_BYPASS_TOKEN`

수집 대상 경쟁사와 Meta 페이지 ID는 웹 대시보드에서 관리합니다.

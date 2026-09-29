# Checkpoint 1 demo evidence

Source revision: `c2edbfefea939dec268ef08c3a9f3967edf08cb9`.

The actual Auto24 service captured `https://www.auto24.ee/soidukid/4344096` for dashboard job `e572dc2a-c030-481e-973b-7b4a106b6ae9`. Submitted `2026-09-29T07:02:52.938965Z`, completed `2026-09-29T07:03:00.049498Z`. The browser automatically changed from queued to captured information. Displayed values match the response: Skoda Enyaq 195kW, 2022, registration2022-03, EUR41500,46800km,195kW and19 photo references. Missing structured make/model remain visibly unavailable; the title is not parsed into invented fields.

- `final-live-submission-et.png`: actual submission, captured07:02:52.589UTC.
- `final-live-wait-et.png`: actual queued state with elapsed wait and last successful check, captured07:02:53.163UTC.
- `final-live-completed-et.png`: actual completed desktop dashboard1440×1000, captured07:03:04UTC.
- `final-live-completed-en.png`: English labels for the same captured information.
- `final-live-mobile-et.png`: actual mobile viewport390×844, no horizontal overflow.
- `checkpoint-1-live-dashboard.json`: sanitized representative result; contact details, photo URLs, credentials and access cookies omitted.
- `checkpoint-1-service-smoke.json`: earlier service-only smoke; separate from dashboard proof.

`checkpoint-1-live-screenshot-sequence.mp4` is a timed sequence of three actual screenshots, not a continuous screen recording. The submission-to-wait interval is0.574s and wait-to-completed capture interval10.837s; the completed frame is held4s for reading. It preserves observed timing but does not show every animation or the exact instant the service completed.

Files prefixed `final-controlled-` use a temporary separate API fixture against the identical production app build. They demonstrate queued/running, delayed processing and interrupted-connection recovery; they are not real car-capture evidence. The fixture and control endpoints are absent from production source and the PR.

The actual demo runs locally at `http://127.0.0.1:3000/et`. A dashboard requires the submitting browser's signed HttpOnly cookie; a URL alone grants no access. Enter a current public Auto24 passenger-car URL to create a new job. The service may independently report a removed/blocked listing. Captured seller text remains in its original language. This checkpoint displays listing information, not a buying verdict or official history.

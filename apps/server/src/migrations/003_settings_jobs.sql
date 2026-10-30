-- 003_settings_jobs.sql — 定时任务与运行记录（对应 PRD Phase 4）

-- 应用级设置，value_json 存完整对象；键名见 services/settings-service.ts
CREATE TABLE app_settings (
  key        TEXT PRIMARY KEY,
  value_json TEXT NOT NULL,
  updated_at TEXT NOT NULL DEFAULT (strftime('%Y-%m-%dT%H:%M:%fZ', 'now'))
);

-- 每次采集/生成任务的审计记录，同时充当“今天是否已经跑过”的锁
CREATE TABLE job_runs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  job         TEXT NOT NULL DEFAULT 'daily' CHECK (job IN ('daily')),
  trigger     TEXT NOT NULL CHECK (trigger IN ('schedule', 'manual')),
  run_date    TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('running', 'ok', 'partial', 'skipped', 'failed')),
  started_at  TEXT NOT NULL,
  finished_at TEXT,
  detail_json TEXT NOT NULL DEFAULT '{}'
);

-- 同一天只允许一条“有效”的定时运行；失败的记录不占位，允许冷却后重试
CREATE UNIQUE INDEX idx_job_runs_schedule_day
  ON job_runs (job, run_date)
  WHERE trigger = 'schedule' AND status <> 'failed';

CREATE INDEX idx_job_runs_started ON job_runs (started_at DESC);

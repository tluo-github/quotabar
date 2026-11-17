-- 里程碑 2：统计页按用户和日期查每日 token
CREATE INDEX daily_user_day ON daily_tokens(user_id, day);
-- 清理任务按时间删历史数据
CREATE INDEX events_ts ON session_events(ts);
CREATE INDEX usage_history_ts ON usage_history(ts);

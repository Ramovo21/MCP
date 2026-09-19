import type { Database } from '../../../packages/database/src/index.js';
import { AppError } from '../../../packages/shared/src/index.js';
export interface RateLimiter {
  consume(key: string): Promise<void>;
}
export class PostgresRateLimiter implements RateLimiter {
  constructor(
    private db: Database,
    private limit = 120,
  ) {}
  async consume(key: string) {
    const r = await this.db.system.query<{ count: number }>(
      "insert into rate_limit_buckets(bucket,count,window_start) values($1,1,date_trunc('minute',now())) on conflict(bucket) do update set count=case when rate_limit_buckets.window_start<date_trunc('minute',now()) then 1 else rate_limit_buckets.count+1 end,window_start=date_trunc('minute',now()) returning count",
      [key],
    );
    if ((r.rows[0]?.count ?? Infinity) > this.limit)
      throw new AppError('RATE_LIMITED', 'Rate limit exceeded; retry in one minute', 429);
  }
}

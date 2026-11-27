import { Request, Response, NextFunction } from 'express';

const requestCounters = new Map<string, number>();
let durationSumMs = 0;
let durationCount = 0;

export function metricsMiddleware(req: Request, res: Response, next: NextFunction) {
  const start = performance.now();
  res.on('finish', () => {
    const duration = performance.now() - start;
    durationSumMs += duration;
    durationCount += 1;
    const routePath = req.route?.path
      ? `${req.baseUrl || ''}${req.route.path}`
      : req.path.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, ':id');
    const key = `${req.method}|${routePath}|${res.statusCode}`;
    requestCounters.set(key, (requestCounters.get(key) ?? 0) + 1);
  });
  next();
}

export function renderPrometheusMetrics(params: {
  postgresUp: boolean;
  redisUp: boolean;
  pythonUp: boolean;
  outboxPending: number;
  jobCounts: Record<string, number>;
}): string {
  const mem = process.memoryUsage();
  const lines: string[] = [
    '# HELP marketsphere_dependency_up Dependency health status (1=up, 0=down)',
    '# TYPE marketsphere_dependency_up gauge',
    `marketsphere_dependency_up{service="postgres"} ${params.postgresUp ? 1 : 0}`,
    `marketsphere_dependency_up{service="redis"} ${params.redisUp ? 1 : 0}`,
    `marketsphere_dependency_up{service="python"} ${params.pythonUp ? 1 : 0}`,
    '# HELP marketsphere_process_uptime_seconds Node.js process uptime in seconds',
    '# TYPE marketsphere_process_uptime_seconds gauge',
    `marketsphere_process_uptime_seconds ${process.uptime().toFixed(2)}`,
    '# HELP marketsphere_process_resident_memory_bytes Resident set size bytes',
    '# TYPE marketsphere_process_resident_memory_bytes gauge',
    `marketsphere_process_resident_memory_bytes ${mem.rss}`,
    '# HELP marketsphere_outbox_events_pending Pending transactional outbox events',
    '# TYPE marketsphere_outbox_events_pending gauge',
    `marketsphere_outbox_events_pending ${params.outboxPending}`,
    '# HELP marketsphere_background_jobs_total Tracked background job records by status',
    '# TYPE marketsphere_background_jobs_total gauge',
  ];

  for (const [status, count] of Object.entries(params.jobCounts)) {
    lines.push(`marketsphere_background_jobs_total{status="${status}"} ${count}`);
  }

  lines.push('# HELP marketsphere_http_request_duration_ms_sum Cumulative HTTP request duration in ms');
  lines.push('# TYPE marketsphere_http_request_duration_ms_sum counter');
  lines.push(`marketsphere_http_request_duration_ms_sum ${durationSumMs.toFixed(2)}`);
  lines.push('# HELP marketsphere_http_request_duration_ms_count Total measured HTTP requests');
  lines.push('# TYPE marketsphere_http_request_duration_ms_count counter');
  lines.push(`marketsphere_http_request_duration_ms_count ${durationCount}`);

  lines.push('# HELP marketsphere_http_requests_total Total HTTP requests by method, route, status');
  lines.push('# TYPE marketsphere_http_requests_total counter');
  for (const [composite, count] of requestCounters.entries()) {
    const [method, route, status] = composite.split('|');
    const safeRoute = (route ?? '/').replace(/"/g, '\\"');
    lines.push(`marketsphere_http_requests_total{method="${method}",route="${safeRoute}",status="${status}"} ${count}`);
  }

  return `${lines.join('\n')}\n`;
}

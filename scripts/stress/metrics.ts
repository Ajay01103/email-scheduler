export function summarize(values: number[]) {
  if (values.length === 0) {
    return { count: 0, min: 0, max: 0, mean: 0, p50: 0, p95: 0, p99: 0 };
  }

  const sorted = [...values].sort((a, b) => a - b);
  const percentile = (p: number) => sorted[Math.ceil(p * sorted.length) - 1]!;

  return {
    count: sorted.length,
    min: sorted[0]!,
    max: sorted[sorted.length - 1]!,
    mean: sorted.reduce((sum, value) => sum + value, 0) / sorted.length,
    p50: percentile(0.5),
    p95: percentile(0.95),
    p99: percentile(0.99),
  };
}

export function deliveryMetrics(rows: Array<{
  scheduledAt: Date | string;
  sentAt: Date | string | null;
  status: string;
  attempts: number;
}>) {
  let sent = 0;
  let failed = 0;
  let uncertain = 0;
  let scheduled = 0;
  let sending = 0;
  let totalAttempts = 0;
  let earlyDeliveries = 0;
  let firstSent = Infinity;
  let lastSent = -Infinity;
  const lags: number[] = [];

  for (const row of rows) {
    totalAttempts += row.attempts;
    switch (row.status) {
      case 'sent': sent++; break;
      case 'failed': failed++; break;
      case 'uncertain': uncertain++; break;
      case 'scheduled': scheduled++; break;
      case 'sending': sending++; break;
    }

    if (row.status !== 'sent' || row.sentAt === null) continue;

    const sentAt = new Date(row.sentAt).getTime();
    const lag = sentAt - new Date(row.scheduledAt).getTime();
    lags.push(Math.max(0, lag));
    if (lag < 0) earlyDeliveries++;
    firstSent = Math.min(firstSent, sentAt);
    lastSent = Math.max(lastSent, sentAt);
  }

  const drainSeconds = lags.length > 0 ? (lastSent - firstSent) / 1000 : 0;
  // The first completion starts the observation window, rather than an interval.
  const throughputPerSecond = sent > 1 && drainSeconds > 0
    ? (sent - 1) / drainSeconds
    : 0;

  return {
    sent,
    failed,
    uncertain,
    scheduled,
    sending,
    totalAttempts,
    earlyDeliveries,
    lagMs: summarize(lags),
    drainSeconds,
    throughputPerSecond,
    throughputPerMinute: throughputPerSecond * 60,
  };
}

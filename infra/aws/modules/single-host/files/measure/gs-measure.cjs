// /opt/gs/measure/gs-measure.cjs -- COST-1: the memory measurement plan's in-process sampler.
//
// Loaded ONLY when a release is deployed with `gs-deploy ... --measure` (gs-run adds NODE_OPTIONS=--require=... and
// mounts this directory read-only). Once a minute it writes ONE line to stdout:
//   GSMEASURE {"t":..,"rss":..,"peak_rss":..,"heap_used":..,"heap_total":..,"heap_limit":..,"external":..,
//              "array_buffers":..,"lag_ms":{"p50":..,"p99":..,"max":..},"elu":..,"cpu_user_ms":..,"cpu_system_ms":..}
// The `GSMEASURE ` prefix makes it NOT JSON, so CloudWatch never extracts a metric from it (it costs log bytes only,
// ~0.3 KB/min). It reads process statistics only, holds no reference to the server, and its timer never keeps the
// process alive; every failure is swallowed. It changes nothing the server decides.
"use strict";
try {
  const { monitorEventLoopDelay, performance } = require("perf_hooks");
  const v8 = require("v8");
  const delay = monitorEventLoopDelay({ resolution: 20 });
  delay.enable();
  const heapLimit = v8.getHeapStatistics().heap_size_limit;
  let lastCpu = process.cpuUsage();
  let lastElu = performance.eventLoopUtilization();
  let peakRss = 0;
  const ms = (ns) => Math.round(ns / 1e4) / 100;
  const timer = setInterval(() => {
    try {
      const memory = process.memoryUsage();
      peakRss = Math.max(peakRss, memory.rss);
      const cpu = process.cpuUsage(lastCpu);
      lastCpu = process.cpuUsage();
      const elu = performance.eventLoopUtilization(lastElu);
      lastElu = performance.eventLoopUtilization();
      const line = {
        t: Date.now(),
        rss: memory.rss,
        peak_rss: peakRss,
        heap_used: memory.heapUsed,
        heap_total: memory.heapTotal,
        heap_limit: heapLimit,
        external: memory.external,
        array_buffers: memory.arrayBuffers,
        lag_ms: { p50: ms(delay.percentile(50)), p99: ms(delay.percentile(99)), max: ms(delay.max) },
        elu: Math.round(elu.utilization * 1000) / 1000,
        cpu_user_ms: Math.round(cpu.user / 1000),
        cpu_system_ms: Math.round(cpu.system / 1000),
      };
      delay.reset();
      process.stdout.write(`GSMEASURE ${JSON.stringify(line)}\n`);
    } catch {
      /* never past here */
    }
  }, 60_000);
  timer.unref();
} catch {
  /* the sampler is optional: a failure to load it never stops the server */
}

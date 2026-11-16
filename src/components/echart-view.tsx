"use client";

import { useEffect, useRef, useState } from "react";
import type { EChartsOption, EChartsType } from "echarts";

/**
 * Mounts one ECharts instance for an option and keeps it sized to its container.
 * ECharts is imported lazily so the workspace bundle stays small until a chart
 * is actually rendered.
 */
export function EChart({
  option,
  label,
  onChartReady,
}: {
  option: EChartsOption;
  label: string;
  onChartReady?: (instance: EChartsType | null) => void;
}) {
  const node = useRef<HTMLDivElement>(null);
  const readyRef = useRef(onChartReady);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    readyRef.current = onChartReady;
  }, [onChartReady]);

  useEffect(() => {
    let disposed = false;
    let instance: EChartsType | null = null;
    let observer: ResizeObserver | undefined;
    import("echarts").then((echarts) => {
      if (disposed || !node.current) return;
      instance = echarts.init(node.current, undefined, { renderer: "canvas" });
      try {
        instance.setOption(option, true);
        readyRef.current?.(instance);
      } catch {
        readyRef.current?.(null);
        setFailed(true);
        return;
      }
      observer = new ResizeObserver(() => instance?.resize());
      observer.observe(node.current);
    }).catch(() => {
      readyRef.current?.(null);
      setFailed(true);
    });
    return () => {
      disposed = true;
      readyRef.current?.(null);
      observer?.disconnect();
      instance?.dispose();
      instance = null;
    };
  }, [option]);

  return (
    <div className="ana-chart-frame">
      <div ref={node} className="ana-chart-canvas" role="img" aria-label={label} />
      {failed && <p className="ana-chart-failed">图表暂时无法显示，请稍后重试或换一种问法。</p>}
    </div>
  );
}

"use client";

import { useEffect, useRef, useState } from "react";
import type { EChartsOption, EChartsType } from "echarts";

/**
 * Mounts one ECharts instance for an option and keeps it sized to its container.
 * ECharts is imported lazily so the workspace bundle stays small until a chart
 * is actually rendered.
 */
export function EChart({ option, label }: { option: EChartsOption; label: string }) {
  const node = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    let disposed = false;
    let instance: EChartsType | null = null;
    let observer: ResizeObserver | undefined;
    import("echarts").then((echarts) => {
      if (disposed || !node.current) return;
      instance = echarts.init(node.current, undefined, { renderer: "canvas" });
      try {
        instance.setOption(option, true);
      } catch {
        setFailed(true);
        return;
      }
      observer = new ResizeObserver(() => instance?.resize());
      observer.observe(node.current);
    }).catch(() => setFailed(true));
    return () => {
      disposed = true;
      observer?.disconnect();
      instance?.dispose();
      instance = null;
    };
  }, [option]);

  return (
    <div className="ana-chart-frame">
      <div ref={node} className="ana-chart-canvas" role="img" aria-label={label} />
      {failed && <p className="ana-chart-failed">图表配置无法渲染，可展开下方原始结果检查。</p>}
    </div>
  );
}

import Link from "next/link";
import { HealthGraphAgent } from "@/components/health-graph-agent";

export const dynamic = "force-dynamic";

export default function GraphPage() {
  return (
    <div className="hg-standalone-page">
      <div className="hg-standalone-nav">
        <Link href="/" className="btn btn-quiet">
          ← 返回知识管理工作台
        </Link>
      </div>
      <HealthGraphAgent open />
    </div>
  );
}

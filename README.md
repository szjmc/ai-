# 知栈入库台

前端使用 Next.js，业务数据连接现有 MySQL `knowledge_files` 表，原文件存放在 MinIO。没有新增其他业务数据库。你提供的 Python 源码仍保存在 `backend/`，未修改其业务逻辑。

> 📘 **开发文档见 [`docs/`](./docs/README.md)**：架构与配置、全部接口的真实请求响应样本、8 个功能模块的实现代码与调用链、测试与部署说明。

## 页面功能

- **预览**：点击文件名或每行的“预览”按钮，打开独立大窗口。PDF 使用完整浏览器阅读器，图片支持适应窗口、原始大小、缩放与旋转，文本提供独立阅读区域。支持铺满屏幕、新窗口打开和下载。
  - **DOCX**：还原文字、标题、列表、表格（含合并单元格）、链接、**代码块**（`HTML Preformatted` 等样式）和**全部图片**。图片不再内嵌 base64，而是通过 `/api/v1/file/[id]/preview-asset` 按需加载（一份含 37 张截图的文档，预览数据从约 9.4 MB 降到约 260 KB，且不会被截断）。页眉页脚、文本框、字体与页边距等 Word 版式不还原，需要完整版式请下载原文件。
  - **XLSX / XLS**：按 Excel 的**真实行号和列字母**显示，保留合并单元格，不显示隐藏的工作表、行和列，数字按单元格格式显示（去掉 `0.0_ ` 这类格式的填充空格）。为保证流畅，单个工作表最多显示 1000 行 × 80 列，超出时会明确提示。
- **文件信息**：每行的“信息”按钮打开独立编辑面板，不再内嵌小预览。不依赖原文件读取成功即可编辑描述、集合、状态、策略和本次操作人（保存后写入 `updated_by`、更新时间与版本号）。
- **操作人维护**：操作人可以在文件信息和上传窗口里直接切换、**新增**（自动分配未占用 ID）或**改名**，并持久保存。名单存放在服务端的 `storage/operators.json`（接口 `GET / POST / PATCH /api/operators`）；`knowledge_files` 仍然只存数字 ID，改名只改显示名，不改历史记录。默认两人：1 林知衡、2 周简。
- **搜索**：输入后自动搜索，也可按回车或点击搜索按钮。支持文件名、随机后缀存储名、集合、描述与类型；多个词用空格分隔（同时匹配）。这不是文档正文全文搜索或图片 OCR。搜索独立于统计加载，筛选条件会显示在结果上方。
- **图片**：支持 PNG、JPG/JPEG、WebP、GIF。由现有 Next.js MinIO/MySQL 适配层接收图片，不更改原 Python 路由的类型白名单。文件按记录 ID 读取，解析记录中的真实桶名与完整对象键，兼容中文、子目录以及旧预签名 URL；不依赖过期签名。
- **源码关闭**：`/backend` 与 `/api/backend/file` 已删除。后端文件和 `.env` 不通过页面展示或下载。上传结果不展示代码或原始接口 JSON。
- **页面插画**：徽标与侧栏插画已内嵌为 SVG，不再依赖 `/images/seal.jpg` 或 `/images/shelves.jpg`。

## 启动

1. 设置连接配置：推荐写在 **`.env.local`**（Next.js 自动加载，优先级高于 `.env`；托管平台每次预览构建都会重写根目录 `.env`，写在那里会丢失）。需要的变量： `MINIO_ENDPOINT`、`MINIO_ACCESS_KEY`、`MINIO_SECRET_KEY`、`MINIO_SECURE`、`KB_BUCKET_NAME` 和 `MYSQL_HOST`、`MYSQL_PORT`、`MYSQL_USER`、`MYSQL_PASSWORD`、`MYSQL_DB`。代码里内置了与你给出的本地配置一致的默认值（MinIO `127.0.0.1:9100`，`minioadmin`；MySQL `127.0.0.1:3306/test_db`，`root`），配置文件缺失或被覆盖时也不会因为空密码而连不上。凭据仅在服务端读取，不要把 `.env` / `.env.local` 上传到公开目录。
2. 启动 MySQL 与 MinIO。在目标 MySQL 库中应用 `backend/sql/knowledge_files.sql`（已有表不要重复执行）。前端读取原表，不新增列，不在搜索请求中自动建库/改表。
3. 安装依赖后运行 `npm run dev`，访问 `http://localhost:3000`。
4. 可选：按 `backend/README.md` 在 `backend/` 启动 FastAPI。文档上传优先走原 FastAPI 路由；该路由已经收到请求后若报错，不会再隐式上传第二份。

默认连接目标沿用你的本地设置：MinIO `127.0.0.1:9100`、知识桶 `knowledge-base`；MySQL `127.0.0.1:3306/test_db`。容器中部署时，`127.0.0.1` 是容器自身，需配置可访问的服务主机。

### 为什么沙箱预览里看不到你的真实数据

配置里的 `127.0.0.1` 指的是**运行页面的那台机器**。在云端沙箱预览里，它指沙箱自己，而不是你的电脑，所以沙箱连不上你电脑上的 MySQL 和 MinIO。要看到你的真实数据和原文件，必须在 MySQL、MinIO 所在的机器上运行本项目（`npm install && npm run dev`）。

连接失败时，页面顶部会明确提示“当前未连接你的 MySQL / MinIO”，并自动使用本机暂存：上传的文件和记录只放在本服务器的 `storage/` 下（`ledger.json` 与 `buckets/`），**不是 MySQL / MinIO 的副本，也不会自动同步**。项目不再生成任何示例数据，暂存区里只有你自己上传的文件。MySQL 模式下 MinIO 写入失败会直接报错，不会伪造对象地址。

## 检查与测试

- `/api/diagnostics`：检查 MySQL/MinIO 连通性，不返回密码或密钥。
- `node --import tsx --test tests/files.test.ts tests/office-preview.test.ts`：搜索、对象路径、图片格式、PDF 范围请求，以及 DOCX（大图不截断、代码块）和 XLSX（真实行列号、合并单元格、隐藏表/行/列、格式填充）的回归测试。
- `node --import tsx --test tests/echarts-option.test.ts tests/chart-insight.test.ts`：智能图表从带 echarts / json 语言标记的代码块、纯文本 JSON 和 outputs/data 包装中提取 ECharts 配置，以及表格 / 智能报告推导的回归测试。
- `node tests/office-browser.mjs`、`node tests/browser-smoke.mjs`：浏览器端回归（需先启动服务，用 `TEST_BASE_URL` 指定地址）。测试自带数据并在结束时清理。
- `npx next typegen`、`npm exec tsc -- --noEmit`、`npm run build`：类型与生产构建检查。

字体位于 `public/fonts/`，复制部署工程时需一并保留。Python 文件保留在工程中但不对外公开。旧版本曾暴露过配置下载入口，若曾公开部署，请更换相关凭据。

## 数据分析助手（Text2Echarts）

工作台「数据分析助手」是对话式的图表工作台：输入问题、选择图表类型后，每轮回答会输出 **图表 + 表格展示 + 要点提示 + 智能报告**，并保留完整对话，可回看历史、重新提问。前端通过同源 Next.js 路由转发到 `FASTAPI_URL`（默认 `http://127.0.0.1:8018`）的 `/api/v1/text2echarts/generate`，不在浏览器中暴露后端地址或密钥。

- **图表**：从工作流返回中提取 ECharts 配置（见 `src/lib/echarts-option.ts`），兼容 Dify 常见的 echarts / json 代码块、代码块前后的说明文字、字符串化的 JSON 以及 `answer`/`outputs`/`data` 等包装字段；只解析 JSON，不执行生成的 JavaScript。
- **表格展示**：优先使用后端新增的 `rows` 字段（SQL 查询结果原样返回），没有时按图表配置反推；单指标时自动补「占比」列（`src/lib/chart-insight.ts`）。
- **智能报告**：本地按结果做算术汇总（样本合计、占比最高、分组差距）与一句话解读，不含模型臆测；命中「高风险 / 高危」分组时给出风险提示。
- 输入框支持 Enter 发送、Shift + Enter 换行，上限 300 字；图表类型以胶囊形式切换。

**部署注意：**`backend/main.py` 已把 `Text2EchartsRouter` 挂载到 `/api/v1/text2echarts`（独立 try 包裹，缺少可选依赖时只降级该功能）；若使用自己的 FastAPI 入口启动，需要同样挂载该路由并配置 `DIFY_API_KEY`、`DIFY_BASE_URL`（超时可用 `DIFY_TIME_OUT`，默认 600 秒）。后端 `execution_time` 统计的是生成图表前的 SQL 查询阶段，并非完整生成耗时。

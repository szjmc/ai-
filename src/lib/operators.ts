import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { OPERATORS } from "./constants";
import { ApiError } from "./errors";
import type { Operator } from "./types";

/**
 * Operator directory. knowledge_files only stores integer ids (created_by / updated_by),
 * so names live here and are resolved at display time. Adding or renaming a person never
 * touches the table: existing records keep their id and show the current name.
 */
function operatorsFile() {
  return process.env.KB_OPERATORS_FILE || path.join(process.cwd(), "storage", "operators.json");
}

const DEFAULTS: Operator[] = OPERATORS.map((operator) => ({ ...operator }));

function sanitize(raw: unknown): Operator[] {
  if (!Array.isArray(raw)) throw new ApiError(503, "操作人名单格式不正确，请检查 storage/operators.json");
  const seen = new Set<number>();
  const list: Operator[] = [];
  for (const item of raw as Operator[]) {
    const id = Number(item?.id);
    const name = typeof item?.name === "string" ? item.name.trim() : "";
    if (!Number.isSafeInteger(id) || id < 1 || !name || seen.has(id)) continue;
    seen.add(id);
    list.push({ id, name, role: typeof item?.role === "string" ? item.role : undefined });
  }
  return list.sort((a, b) => a.id - b.id);
}

export async function listOperators(): Promise<Operator[]> {
  try {
    const parsed = JSON.parse(await readFile(operatorsFile(), "utf8")) as { operators?: unknown };
    // An empty directory is almost always a mistake; fall back to the defaults.
    return sanitize(parsed.operators).length ? sanitize(parsed.operators) : [...DEFAULTS];
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [...DEFAULTS];
    if (error instanceof ApiError) throw error;
    throw new ApiError(503, "操作人名单读取失败，请检查 storage/operators.json");
  }
}

async function writeOperators(list: Operator[]) {
  const file = operatorsFile();
  await mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${randomUUID()}.tmp`;
  await writeFile(temp, JSON.stringify({ operators: list }, null, 2), "utf8");
  await rename(temp, file);
}

let queue: Promise<unknown> = Promise.resolve();
function serialize<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.catch(() => undefined);
  return run;
}

function validName(name: unknown) {
  const value = typeof name === "string" ? name.trim() : "";
  if (!value || value.length > 20) throw new ApiError(400, "操作人姓名须为 1–20 个字符");
  return value;
}

export async function addOperator(input: { name: unknown; id?: unknown }): Promise<Operator> {
  return serialize(async () => {
    const name = validName(input.name);
    const list = await listOperators();
    if (list.some((operator) => operator.name === name)) throw new ApiError(409, "该操作人姓名已存在");
    let id: number;
    if (input.id != null && input.id !== "") {
      id = Number(input.id);
      if (!Number.isSafeInteger(id) || id < 1 || id > 2147483647) throw new ApiError(400, "操作人 ID 须为正整数");
      if (list.some((operator) => operator.id === id)) throw new ApiError(409, `操作人 ID ${id} 已被占用`);
    } else {
      id = list.reduce((max, operator) => Math.max(max, operator.id), 0) + 1;
    }
    const operator: Operator = { id, name };
    await writeOperators([...list, operator].sort((a, b) => a.id - b.id));
    return operator;
  });
}

export async function renameOperator(id: number, name: unknown): Promise<Operator> {
  return serialize(async () => {
    if (!Number.isSafeInteger(id) || id < 1) throw new ApiError(400, "操作人 ID 不合法");
    const nextName = validName(name);
    const list = await listOperators();
    const target = list.find((operator) => operator.id === id);
    if (!target) throw new ApiError(404, "操作人不存在");
    if (list.some((operator) => operator.id !== id && operator.name === nextName)) throw new ApiError(409, "该操作人姓名已存在");
    target.name = nextName;
    await writeOperators(list);
    return target;
  });
}

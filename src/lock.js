import {
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  realpathSync,
} from "node:fs";
import { resolve, dirname, basename } from "node:path";
// Single local owner across ports. A stale PID is reclaimed; ambiguous locks fail closed.
export function lockDatabase(path) {
  mkdirSync(dirname(resolve(path)), { recursive: true, mode: 0o700 });
  const full = resolve(realpathSync(dirname(resolve(path))), basename(path));
  const lock = full + ".lock";
  try {
    mkdirSync(lock, { mode: 0o700 });
  } catch (e) {
    if (e.code !== "EEXIST") throw e;
    let pid;
    try {
      pid = Number(readFileSync(lock + "/pid", "utf8"));
    } catch {
      throw Error(`数据库锁不完整，请确认没有服务运行后移除 ${lock}`);
    }
    if (!Number.isSafeInteger(pid) || pid < 1)
      throw Error(`数据库锁无效: ${lock}`);
    try {
      process.kill(pid, 0);
      throw Error(`数据库已由进程 ${pid} 使用`);
    } catch (err) {
      if (err.code !== "ESRCH") throw err;
    }
    const reclaim = lock + ".reclaim";
    try {
      mkdirSync(reclaim, { mode: 0o700 });
    } catch {
      throw Error(`另一个进程正在恢复数据库锁: ${reclaim}`);
    }
    try {
      const latest = Number(readFileSync(lock + "/pid", "utf8"));
      if (latest !== pid) throw Error("数据库锁归属已改变，请重试");
      rmSync(lock, { recursive: true });
      mkdirSync(lock, { mode: 0o700 });
      writeFileSync(lock + "/pid", String(process.pid), {
        mode: 0o600,
        flag: "wx",
      });
    } finally {
      rmSync(reclaim, { recursive: true });
    }
    return () => {
      if (readFileSync(lock + "/pid", "utf8") === String(process.pid))
        rmSync(lock, { recursive: true });
    };
  }
  writeFileSync(lock + "/pid", String(process.pid), {
    mode: 0o600,
    flag: "wx",
  });
  return () => {
    if (readFileSync(lock + "/pid", "utf8") === String(process.pid))
      rmSync(lock, { recursive: true });
  };
}

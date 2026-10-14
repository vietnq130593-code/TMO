/**
 * Unit tests for resolveCwd.
 * Run: bun test src/lib/workspace/__tests__/resolve-cwd.test.ts
 * (R11: chuyển vitest → bun:test theo convention tests/ của repo — không thêm dependency)
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, test } from "bun:test";
import { resolveCwd, resolveCwdString } from "../resolve-cwd";

let tmpRoot: string;
let subDir: string;
let aFile: string;
const logs: string[] = [];
const logger = (l: string) => logs.push(l);

beforeAll(() => {
  tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), "resolve-cwd-"));
  subDir = path.join(tmpRoot, "ok");
  fs.mkdirSync(subDir);
  aFile = path.join(tmpRoot, "not-a-dir.txt");
  fs.writeFileSync(aFile, "x");
});

afterAll(() => fs.rmSync(tmpRoot, { recursive: true, force: true }));

const base = () => ({ allowedRoots: [tmpRoot], fallback: subDir, logger });

describe("resolveCwd", () => {
  test("accepts a valid existing directory", () => {
    const r = resolveCwd({ ...base(), input: subDir });
    expect(r.rejected).toBe(false);
    expect(r.cwd).toBe(path.resolve(subDir));
  });

  test("REJECTS the exact malformed production path (drive letter)", () => {
    const r = resolveCwd({ ...base(), input: "/home/z/tmo-app/E:\\APP\\TMO-clone" });
    expect(r.rejected).toBe(true);
    expect(r.reason).toBe("DRIVE_LETTER");
    expect(r.cwd).toBe(path.resolve(subDir)); // fallback, never the bad cwd
  });

  test("rejects a foreign backslash separator on POSIX", () => {
    const r = resolveCwd({ ...base(), input: `${tmpRoot}\\ok` });
    if (path.sep === "/") {
      expect(r.rejected).toBe(true);
      expect(r.reason).toBe("FOREIGN_SEPARATOR");
    }
  });

  test("rejects empty / missing input", () => {
    expect(resolveCwd({ ...base(), input: "" }).reason).toBe("EMPTY");
    expect(resolveCwd({ ...base(), input: "   " }).reason).toBe("EMPTY");
    expect(resolveCwd({ ...base(), input: undefined }).reason).toBe("EMPTY");
    expect(resolveCwd({ ...base(), input: null }).reason).toBe("EMPTY");
  });

  test("rejects NUL byte injection", () => {
    expect(resolveCwd({ ...base(), input: `${subDir}\0` }).reason).toBe("NULL_BYTE");
  });

  test("rejects `..` traversal in both separator styles", () => {
    // R11: KHÔNG dùng path.join(subDir, "..") — join tự NORMALIZE dấu ".."
    // mất trước khi resolveCwd thấy (thông tin traversal bị hủy ở test, không
    // phải impl) — dùng chuỗi thô giữ nguyên ý định thoát lên cha.
    expect(resolveCwd({ ...base(), input: `${subDir}/..` }).reason).toBe("TRAVERSAL");
    expect(resolveCwd({ ...base(), input: `${subDir}\\..` }).reason).toBe("TRAVERSAL");
  });

  test("rejects a non-existent path", () => {
    const r = resolveCwd({ ...base(), input: path.join(tmpRoot, "nope") });
    expect(r.rejected).toBe(true);
    expect(r.reason).toBe("NOT_FOUND");
  });

  test("rejects an existing FILE (existence check alone is not enough)", () => {
    const r = resolveCwd({ ...base(), input: aFile });
    expect(r.rejected).toBe(true);
    expect(r.reason).toBe("NOT_A_DIRECTORY");
  });

  test("rejects a directory outside the allow-list", () => {
    const r = resolveCwd({ ...base(), input: os.homedir() });
    if (path.resolve(os.homedir()) !== path.resolve(tmpRoot)) {
      expect(r.rejected).toBe(true);
      expect(r.reason).toBe("OUTSIDE_ALLOWED_ROOT");
    }
  });

  test("never returns a relative path", () => {
    const r = resolveCwd({ ...base(), input: "ok" });
    expect(path.isAbsolute(r.cwd)).toBe(true);
  });

  test("emits a structured log line containing the reason code on reject", () => {
    logs.length = 0;
    resolveCwd({
      ...base(),
      input: "/home/z/tmo-app/E:\\APP\\TMO-clone",
      callSite: "dev-tools/bash",
      requestId: "req-1",
    });
    expect(logs.length).toBeGreaterThan(0);
    const parsed = JSON.parse(logs[0]);
    expect(parsed.event).toBe("cwd_rejected");
    expect(parsed.reason).toBe("DRIVE_LETTER");
    expect(parsed.callSite).toBe("dev-tools/bash");
    expect(parsed.requestId).toBe("req-1");
  });

  test("resolveCwdString returns the same safe string", () => {
    expect(resolveCwdString({ ...base(), input: subDir })).toBe(path.resolve(subDir));
    expect(resolveCwdString({ ...base(), input: "E:\\x" })).toBe(path.resolve(subDir));
  });
});
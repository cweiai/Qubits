import { afterEach, describe, expect, it } from "vitest";
import {
  ContainerSandboxProvider,
  getSandboxProvider,
  describeSandboxProvider,
} from "@/lib/ai/tools/sandbox-provider";
import { dockerAvailable } from "./fakes";

/**
 * SandboxProvider boundary tests: the ONLY provider is the Docker container
 * (physical isolation, fail closed). There is no local provider, no demo provider
 * and no host-execution fallback. Real-Docker tests run only when a daemon is up.
 */

const ORIGINAL_PATH = process.env.PATH;
const ORIGINAL_PROVIDER = process.env.SANDBOX_PROVIDER;

afterEach(() => {
  if (ORIGINAL_PROVIDER === undefined) delete process.env.SANDBOX_PROVIDER;
  else process.env.SANDBOX_PROVIDER = ORIGINAL_PROVIDER;
  process.env.PATH = ORIGINAL_PATH;
});

describe("ContainerSandboxProvider（唯一 provider，fail closed）", () => {
  it("明确标记：生产隔离边界", () => {
    const provider = new ContainerSandboxProvider();
    expect(provider.kind).toBe("container");
    expect(provider.isProductionSecurityBoundary).toBe(true);
    expect(provider.securityBoundaryNote).toContain("容器");
    const info = describeSandboxProvider(provider);
    expect(info.provider).toBe("container");
  });

  it("Docker 不可用时 fail closed：exec 返回 PROVIDER_UNAVAILABLE，绝不执行宿主命令", async () => {
    // Make docker unreachable deterministically (PATH without docker).
    process.env.PATH = "/nonexistent";
    const provider = new ContainerSandboxProvider();
    expect(provider.isAvailable()).toBe(false);
    const info = describeSandboxProvider(provider);
    expect(info.available).toBe(false);
    const result = await provider.exec({
      command: "node",
      args: ["-e", "console.log('should never run')"],
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toContain("PROVIDER_UNAVAILABLE");
    expect(result.stdout).not.toContain("should never run");
  });

  it("create 在 Docker 不可用时同样 fail closed", async () => {
    process.env.PATH = "/nonexistent";
    const provider = new ContainerSandboxProvider();
    await expect(provider.create(process.cwd())).rejects.toThrowError(/PROVIDER_UNAVAILABLE|容器沙盒不可用/);
  });

  it("exec 校验 command/args/cwd：非法输入被拒绝且不启动容器", async () => {
    const provider = new ContainerSandboxProvider();
    // command 不在 allowlist
    const denied = await provider.exec({ command: "rm", args: ["-rf", "/"], cwd: process.cwd(), timeoutMs: 3000 });
    expect(denied.exitCode).toBe(126);
    expect(denied.stderr).toContain("allowlist");
    // command 带路径
    const pathCommand = await provider.exec({ command: "/bin/bash", args: [], cwd: process.cwd(), timeoutMs: 3000 });
    expect(pathCommand.exitCode).toBe(126);
    // cwd 不存在
    const badCwd = await provider.exec({ command: "bash", args: ["-lc", "true"], cwd: "/nonexistent-cwd-qubits", timeoutMs: 3000 });
    expect(badCwd.exitCode).toBe(126);
    expect(badCwd.stderr).toContain("cwd");
    // args 含 NUL
    const badArgs = await provider.exec({ command: "bash", args: ["-lc", "true\0bad"], cwd: process.cwd(), timeoutMs: 3000 });
    expect(badArgs.exitCode).toBe(126);
  });
});

describe("getSandboxProvider（永远 container）", () => {
  it("默认与显式 container 都返回容器 provider；任何其他值拒绝启动", () => {
    delete process.env.SANDBOX_PROVIDER;
    expect(getSandboxProvider().kind).toBe("container");
    process.env.SANDBOX_PROVIDER = "container";
    expect(getSandboxProvider().kind).toBe("container");
    for (const bad of ["local-dev", "local-demo", "none", "unknown-provider"]) {
      process.env.SANDBOX_PROVIDER = bad;
      expect(() => getSandboxProvider()).toThrowError(/只允许 container/);
    }
  });
});

describe("真实 Docker 集成（需要 Docker daemon）", () => {
  const enabled = dockerAvailable();
  it.skipIf(!enabled)("describeSandboxProvider 与真实 Docker 状态一致", () => {
    const provider = new ContainerSandboxProvider();
    const info = describeSandboxProvider(provider);
    expect(info.available).toBe(true);
    expect(provider.isAvailable()).toBe(true);
  });

  it.skipIf(!enabled)("容器物理隔离：workspace 可见，宿主文件不可见，且可写 workspace", async () => {
    const { mkdirSync, rmSync, writeFileSync, readFileSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const path = await import("node:path");
    const ws = path.join(homedir(), ".qubits-sandbox-test-" + Date.now());
    mkdirSync(ws, { recursive: true });
    writeFileSync(path.join(ws, "marker.txt"), "hello-workspace");
    try {
      const provider = new ContainerSandboxProvider();
      const result = await provider.exec({
        command: "bash",
        args: ["-lc", "cat marker.txt; echo ---; ls /Users 2>&1 | head -1; echo hi > new.txt"],
        cwd: ws,
        timeoutMs: 60000,
      });
      expect(result.exitCode).toBe(0);
      expect(result.stdout).toContain("hello-workspace");
      expect(result.stdout).toContain("No such file");
      expect(readFileSync(path.join(ws, "new.txt"), "utf8")).toBe("hi\n");
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 90000);

  it.skipIf(!enabled)("顺序执行超过并发上限次数不会耗尽进程槽位", async () => {
    const { mkdirSync, rmSync } = await import("node:fs");
    const { homedir } = await import("node:os");
    const path = await import("node:path");
    const ws = path.join(homedir(), ".qubits-sandbox-slots-" + Date.now());
    mkdirSync(ws, { recursive: true });
    try {
      const provider = new ContainerSandboxProvider();
      for (let index = 0; index < 10; index++) {
        const result = await provider.exec({
          command: "node",
          args: ["-e", "console.log('run-" + index + "')"],
          cwd: ws,
          timeoutMs: 60000,
        });
        expect(result.exitCode).toBe(0);
        expect(result.stderr).not.toContain("子进程数量超出上限");
      }
    } finally {
      rmSync(ws, { recursive: true, force: true });
    }
  }, 180000);
});

import { afterEach, describe, expect, it } from "vitest";
import {
  ContainerSandboxProvider,
  LocalDevSandboxProvider,
  getSandboxProvider,
  describeSandboxProvider,
} from "@/lib/ai/tools/sandbox-provider";

/**
 * SandboxProvider boundary tests: LocalDevSandbox is explicitly NOT a production
 * security boundary; ContainerSandbox fails closed when Docker is unavailable and
 * never falls back to host execution.
 */

const ORIGINAL_PATH = process.env.PATH;

afterEach(() => {
  delete process.env.SANDBOX_PROVIDER;
  process.env.PATH = ORIGINAL_PATH;
});

describe("LocalDevSandboxProvider", () => {
  it("明确标记：不是生产安全边界", () => {
    const provider = new LocalDevSandboxProvider();
    expect(provider.kind).toBe("local-dev");
    expect(provider.isProductionSecurityBoundary).toBe(false);
    expect(provider.securityBoundaryNote).toContain("不是生产安全边界");
    const info = describeSandboxProvider(provider);
    expect(info.available).toBe(true);
    expect(info.note).toContain("不是生产安全边界");
  });

  it("spawn 无 shell:true，命令 allowlist 生效", async () => {
    const provider = new LocalDevSandboxProvider();
    const denied = await provider.exec({
      command: "rm",
      args: ["-rf", "/"],
      cwd: process.cwd(),
      timeoutMs: 3000,
    });
    expect(denied.exitCode).toBe(126);
    expect(denied.stderr).toContain("allowlist");
  });

  it("敏感环境变量被剥离", async () => {
    process.env.OPENAI_API_KEY = "sk-should-not-leak";
    process.env.DATABASE_URL = "file:./secret.db";
    const provider = new LocalDevSandboxProvider();
    const result = await provider.exec({
      command: "node",
      args: ["-e", "console.log(process.env.OPENAI_API_KEY || 'EMPTY'); console.log(process.env.DATABASE_URL || 'EMPTY')"],
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    expect(result.stdout).toContain("EMPTY");
  });
});

describe("ContainerSandboxProvider（生产接口，fail closed）", () => {
  it("Docker 不可用时 fail closed：exec 返回 PROVIDER_UNAVAILABLE，绝不回退宿主执行", async () => {
    // Make docker unreachable deterministically (PATH without docker).
    process.env.PATH = "/nonexistent";
    const provider = new ContainerSandboxProvider();
    expect(provider.isProductionSecurityBoundary).toBe(true);
    expect(provider.securityBoundaryNote).toContain("容器");
    const result = await provider.exec({
      command: "node",
      args: ["-e", "console.log('should never run')"],
      cwd: process.cwd(),
      timeoutMs: 5000,
    });
    expect(result.exitCode).toBe(125);
    expect(result.stderr).toContain("PROVIDER_UNAVAILABLE");
    expect(result.stderr).toContain("fail closed");
    expect(result.stdout).not.toContain("should never run");
  });

  it("create 在 Docker 不可用时同样 fail closed", async () => {
    process.env.PATH = "/nonexistent";
    const provider = new ContainerSandboxProvider();
    await expect(provider.create(process.cwd())).rejects.toThrowError(/PROVIDER_UNAVAILABLE|容器沙盒不可用/);
  });
});

describe("getSandboxProvider", () => {
  it("默认 container（物理隔离）；local-dev 仅显式指定；未知值不静默回退", () => {
    delete process.env.SANDBOX_PROVIDER;
    expect(getSandboxProvider()?.kind).toBe("container");
    process.env.SANDBOX_PROVIDER = "container";
    expect(getSandboxProvider()?.kind).toBe("container");
    process.env.SANDBOX_PROVIDER = "local-dev";
    expect(getSandboxProvider()?.kind).toBe("local-dev");
    process.env.SANDBOX_PROVIDER = "local-demo"; // legacy value → dev sandbox
    expect(getSandboxProvider()?.kind).toBe("local-dev");
    process.env.SANDBOX_PROVIDER = "unknown-provider";
    expect(getSandboxProvider()).toBeNull();
    process.env.SANDBOX_PROVIDER = "none";
    expect(getSandboxProvider()).toBeNull();
  });
});

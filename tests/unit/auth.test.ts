import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { NextRequest } from "next/server";
import { AppRepository } from "@/lib/db/repository";
import { hashPassword, verifyPassword } from "@/lib/server/auth";
import { resolveProjectId } from "@/lib/sandbox/server-session";

describe("authentication", () => {
  let dir: string;
  let repo: AppRepository;

  beforeEach(() => {
    dir = mkdtempSync(path.join(tmpdir(), "qubits-auth-"));
    repo = new AppRepository(path.join(dir, "test.db"));
  });

  afterEach(() => {
    repo.close();
    rmSync(dir, { recursive: true, force: true });
  });

  it("stores password hashes that can be verified", () => {
    const encoded = hashPassword("correct-password");
    expect(encoded).not.toContain("correct-password");
    expect(verifyPassword("correct-password", encoded)).toBe(true);
    expect(verifyPassword("wrong-password", encoded)).toBe(false);
  });

  it("does not allow one user to select another user's project", () => {
    const now = Date.now();
    const first = repo.createUser({ id: "usr-first", email: "first@example.com", passwordHash: "hash" });
    const second = repo.createUser({ id: "usr-second", email: "second@example.com", passwordHash: "hash" });
    repo.ensureProject("prj-first-0001");
    repo.ensureProject("prj-second-0002");
    repo.setProjectUser("prj-first-0001", first.id);
    repo.setProjectUser("prj-second-0002", second.id);
    repo.createAuthSession({ id: "sess-aaaaaaaaaaaaaaaa", userId: first.id, expiresAt: now + 60_000 });

    const request = new NextRequest("http://localhost/api/projects/current", {
      headers: { cookie: "qubits_auth=sess-aaaaaaaaaaaaaaaa; qubits_project=prj-second-0002" },
    });

    expect(resolveProjectId(request, repo)).toBe("prj-first-0001");
  });

  it("requires authentication after logout", () => {
    const user = repo.createUser({ id: "usr-owner", email: "owner@example.com", passwordHash: "hash" });
    repo.ensureProject("prj-owner-0001");
    repo.setProjectUser("prj-owner-0001", user.id);
    const request = new NextRequest("http://localhost/api/projects/current", {
      headers: { cookie: "qubits_project=prj-owner-0001" },
    });

    expect(() => resolveProjectId(request, repo)).toThrowError("请先登录");
  });
});

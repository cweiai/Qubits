"use client";

import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Boxes, Eye, EyeOff, Loader2 } from "lucide-react";
import { WorkspaceShell } from "@/components/workspace/workspace-shell";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { api, friendlyError, type AuthUser } from "@/lib/workspace/api";
import { cn } from "@/lib/utils";

type AuthMode = "login" | "register";

export function AuthShell() {
  const [user, setUser] = useState<AuthUser | null>(null);
  const [loadingUser, setLoadingUser] = useState(true);

  useEffect(() => {
    let cancelled = false;
    void api
      .getCurrentUser()
      .then(({ user: current }) => {
        if (!cancelled) setUser(current);
      })
      .catch(() => undefined)
      .finally(() => {
        if (!cancelled) setLoadingUser(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const logout = async () => {
    await api.logout();
    setUser(null);
  };

  if (loadingUser) return <AuthLoading />;
  if (!user) return <AuthScreen onAuthenticated={setUser} />;
  return <WorkspaceShell user={user} onLogout={() => void logout()} />;
}

function AuthLoading() {
  return (
    <div className="flex h-dvh items-center justify-center bg-zinc-50 text-zinc-600">
      <div className="flex items-center gap-2 text-sm">
        <Loader2 className="h-4 w-4 animate-spin" />
        正在验证登录状态…
      </div>
    </div>
  );
}

function AuthScreen({ onAuthenticated }: { onAuthenticated(user: AuthUser): void }) {
  const [mode, setMode] = useState<AuthMode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [confirmPassword, setConfirmPassword] = useState("");
  const [showPassword, setShowPassword] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const switchMode = (next: AuthMode) => {
    setMode(next);
    setError(null);
  };

  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setError(null);
    if (mode === "register" && password !== confirmPassword) {
      setError("两次输入的密码不一致");
      return;
    }
    setSubmitting(true);
    try {
      const result = mode === "login" ? await api.login(email, password) : await api.register(email, password, confirmPassword);
      onAuthenticated(result.user);
    } catch (submitError) {
      setError(friendlyError(submitError));
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="relative flex min-h-dvh flex-col bg-zinc-50 text-foreground">
      <header className="flex h-16 shrink-0 items-center border-b bg-white px-5 sm:px-8">
        <div className="flex items-center gap-2.5">
          <div className="flex h-8 w-8 items-center justify-center rounded-md bg-sky-600 text-white">
            <Boxes className="h-4 w-4" />
          </div>
          <div>
            <p className="text-sm font-semibold leading-none">Qubits</p>
            <p className="mt-1 text-[11px] text-muted-foreground">对话式应用生成器</p>
          </div>
        </div>
      </header>
      <main className="flex flex-1 items-center justify-center px-4 py-8 sm:px-6">
        <section className="w-full max-w-sm rounded-lg border bg-white shadow-sm" aria-labelledby="auth-title">
          <div className="border-b px-6 pb-5 pt-6">
            <h1 id="auth-title" className="text-xl font-semibold">
              {mode === "login" ? "登录 Qubits" : "创建账户"}
            </h1>
            <p className="mt-1.5 text-sm text-muted-foreground">
              {mode === "login" ? "登录后继续使用你的工作区。" : "注册账户并进入独立工作区。"}
            </p>
          </div>
          <div className="px-6 pb-6 pt-5">
            <div className="mb-5 grid h-9 grid-cols-2 rounded-md bg-zinc-100 p-1" role="tablist" aria-label="账户操作">
              <ModeButton active={mode === "login"} onClick={() => switchMode("login")}>登录</ModeButton>
              <ModeButton active={mode === "register"} onClick={() => switchMode("register")}>注册</ModeButton>
            </div>
            <form className="space-y-4" onSubmit={submit}>
              <label className="block space-y-1.5 text-sm font-medium">
                <span>邮箱</span>
                <Input
                  type="email"
                  autoComplete="email"
                  value={email}
                  onChange={(event) => setEmail(event.target.value)}
                  placeholder="name@example.com"
                  required
                />
              </label>
              <label className="block space-y-1.5 text-sm font-medium">
                <span>密码</span>
                <div className="relative">
                  <Input
                    type={showPassword ? "text" : "password"}
                    autoComplete={mode === "login" ? "current-password" : "new-password"}
                    value={password}
                    onChange={(event) => setPassword(event.target.value)}
                    minLength={8}
                    maxLength={128}
                    className="pr-10"
                    placeholder="至少 8 位"
                    required
                  />
                  <button
                    type="button"
                    className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground hover:text-foreground"
                    aria-label={showPassword ? "隐藏密码" : "显示密码"}
                    title={showPassword ? "隐藏密码" : "显示密码"}
                    onClick={() => setShowPassword((value) => !value)}
                  >
                    {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                  </button>
                </div>
              </label>
              {mode === "register" ? (
                <label className="block space-y-1.5 text-sm font-medium">
                  <span>确认密码</span>
                  <div className="relative">
                    <Input
                      type={showPassword ? "text" : "password"}
                      autoComplete="new-password"
                      value={confirmPassword}
                      onChange={(event) => setConfirmPassword(event.target.value)}
                      minLength={8}
                      maxLength={128}
                      className="pr-10"
                      placeholder="再次输入密码"
                      required
                    />
                    <button
                      type="button"
                      className="absolute inset-y-0 right-0 flex w-10 items-center justify-center text-muted-foreground hover:text-foreground"
                      aria-label={showPassword ? "隐藏确认密码" : "显示确认密码"}
                      title={showPassword ? "隐藏确认密码" : "显示确认密码"}
                      onClick={() => setShowPassword((value) => !value)}
                    >
                      {showPassword ? <EyeOff className="h-4 w-4" /> : <Eye className="h-4 w-4" />}
                    </button>
                  </div>
                </label>
              ) : null}
              {error ? <p className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</p> : null}
              <Button type="submit" className="w-full" disabled={submitting}>
                {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
                {mode === "login" ? "登录" : "注册并进入"}
              </Button>
            </form>
          </div>
        </section>
      </main>
    </div>
  );
}

function ModeButton({ active, onClick, children }: { active: boolean; onClick(): void; children: ReactNode }) {
  return (
    <button
      type="button"
      role="tab"
      aria-selected={active}
      className={cn("rounded-sm text-sm transition-colors", active ? "bg-white font-medium text-foreground shadow-sm" : "text-muted-foreground")}
      onClick={onClick}
    >
      {children}
    </button>
  );
}

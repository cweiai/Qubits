import type { Metadata, Viewport } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "Qubits — 对话式应用生成器",
  description:
    "用自然语言描述需求，多个 AI 角色协作生成一个可以真实使用的单页网页应用。",
};

export const viewport: Viewport = {
  width: "device-width",
  initialScale: 1,
};

export default function RootLayout({ children }: Readonly<{ children: React.ReactNode }>) {
  return (
    // suppressHydrationWarning: browser extensions (e.g. immersive-translate) inject
    // data-* attributes into <html> before hydration, causing mismatch warnings.
    // This is the official escape hatch; it only suppresses attribute warnings here.
    <html lang="zh-CN" suppressHydrationWarning>
      <body>{children}</body>
    </html>
  );
}

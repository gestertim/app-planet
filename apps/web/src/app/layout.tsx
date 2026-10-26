import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "App Planet｜本機介面預覽",
  description: "App Planet 本機合成資料介面骨架，未連接正式服務。",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="zh-Hant">
      <body>{children}</body>
    </html>
  );
}

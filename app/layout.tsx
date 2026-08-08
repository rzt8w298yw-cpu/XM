import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "XM 自動シグナル判定",
  description: "マルチタイムフレームの15条件からBUY/SELL/WAITを自動判定するFXシグナルダッシュボード",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="ja">
      <body>{children}</body>
    </html>
  );
}

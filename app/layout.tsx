import type { Metadata } from "next";
import "./globals.css";

export const metadata: Metadata = {
  title: "KC Farm System",
  description: "KC Royals minor league roster viewer",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en">
      <body className="font-sans min-h-screen">{children}</body>
    </html>
  );
}

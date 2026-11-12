/* eslint-disable @next/next/no-page-custom-font -- app-router root layout; the Google Fonts <link> loads globally and is required by the design spec */
import type { Metadata, Viewport } from "next";
import "./globals.css";
import { Toaster } from "@/components/ui/sonner";

export const metadata: Metadata = {
  title: "کوپیر چندترمیناله MT5",
  description:
    "داشبورد حرفه‌ای کپی معاملات بین ترمینال‌های متاتریدر ۵ — تمام داده‌ها به‌صورت محلی ذخیره می‌شوند",
};

export const viewport: Viewport = {
  themeColor: "#09090b",
};

export default function RootLayout({
  children,
}: Readonly<{
  children: React.ReactNode;
}>) {
  return (
    <html lang="fa" dir="rtl" className="dark" suppressHydrationWarning>
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link
          rel="preconnect"
          href="https://fonts.gstatic.com"
          crossOrigin="anonymous"
        />
        <link
          href="https://fonts.googleapis.com/css2?family=Vazirmatn:wght@400;500;600;700&display=swap"
          rel="stylesheet"
        />
      </head>
      <body className="antialiased bg-background text-foreground">
        {children}
        <Toaster richColors position="bottom-left" theme="dark" closeButton />
      </body>
    </html>
  );
}

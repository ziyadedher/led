import type { Metadata, Viewport } from "next";
import { JetBrains_Mono } from "next/font/google";
import React from "react";

import "@/globals.css";

const jetbrainsMono = JetBrains_Mono({
  subsets: ["latin"],
  weight: ["400", "500", "600", "700"],
  variable: "--font-jetbrains",
  display: "swap",
});

export const metadata: Metadata = {
  title: "ziyad's leds",
  description: "Telemetry-grade composer for a 64×64 RGB LED panel.",
};

export const viewport: Viewport = {
  themeColor: "#08080a",
  colorScheme: "dark",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html lang="en" className={`dark ${jetbrainsMono.variable}`}>
      <body className="font-mono antialiased">{children}</body>
    </html>
  );
}

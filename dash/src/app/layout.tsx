import cx from "classnames";
import type { Metadata } from "next";
import { Inter } from "next/font/google";
import React from "react";

import "@/globals.css";

const inter = Inter({ subsets: ["latin"] });

export const metadata: Metadata = {
  title: "Ziyad's LED Text Server",
};

export default function RootLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return (
    <html className="h-full bg-white">
      <body className={cx("h-full", inter.className)}>
        <main className="h-full">{children}</main>
      </body>
    </html>
  );
}

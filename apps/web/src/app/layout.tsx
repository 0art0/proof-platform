import type { Metadata } from "next";
import type { ReactNode } from "react";
import "mathlive/fonts.css";
import "./styles.css";
import { AppBar } from "./app-bar";

export const metadata: Metadata = {
  title: "Proof Platform",
  description: "Interactive mathematical discovery",
};

// Inter for the interface, STIX Two for typeset mathematics and titles, JetBrains Mono for
// ids and source. Each stack in styles.css falls back to system fonts if this sheet is blocked.
const FONTS_HREF =
  "https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600;700&family=STIX+Two+Text:ital,wght@0,400;0,500;0,600;1,400;1,500&family=JetBrains+Mono:wght@400;500&display=swap";

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <head>
        <link rel="preconnect" href="https://fonts.googleapis.com" />
        <link rel="preconnect" href="https://fonts.gstatic.com" crossOrigin="anonymous" />
        <link rel="stylesheet" href={FONTS_HREF} />
      </head>
      <body>
        <AppBar />
        {children}
      </body>
    </html>
  );
}

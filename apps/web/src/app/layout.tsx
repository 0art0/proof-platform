import type { Metadata } from "next";
import type { ReactNode } from "react";
import "mathlive/fonts.css";
import "./styles.css";

export const metadata: Metadata = {
  title: "Proof Platform",
  description: "Interactive mathematical discovery",
};

export default function RootLayout({ children }: Readonly<{ children: ReactNode }>) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
